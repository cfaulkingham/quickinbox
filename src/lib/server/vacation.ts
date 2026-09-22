import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { EmailProviderKind, MailAddress } from '$lib/types';
import { parseEmailAddress } from './email-address';
import { prepareOutboundEmail, type OutboundMailInput } from './send-mail';
import { enqueueOutbound } from './durable-outbox';
import type { insertEmail } from './mail-store';
import { recordOperationalFailure } from './operational-events';

/** Only explicit personal recipients; never reply to automated/list/bounce mail. */
export function vacationRecipient(
	headers: Headers | Record<string, string> | undefined,
	from: string,
	direct: boolean,
	envelope?: string
) {
	if (!direct || !headers) return null;
	const h = headers instanceof Headers ? headers : new Headers(headers);
	const automatic = h.get('auto-submitted');
	if (
		(automatic && automatic.trim().toLowerCase() !== 'no') ||
		h.has('list-id') ||
		h.has('list-unsubscribe') ||
		/bulk|list|junk/i.test(h.get('precedence') || '') ||
		/all|oof|autoreply/i.test(h.get('x-auto-response-suppress') || '') ||
		/multipart\/report|message\/delivery-status/i.test(h.get('content-type') || '')
	)
		return null;
	const path = envelope ?? h.get('return-path');
	if (!path || path.trim() === '<>') return null;
	const recipient = parseEmailAddress(path).toLowerCase();
	// Avoid reflecting a response to a third party through a forged Return-Path.
	if (
		recipient !== parseEmailAddress(from).toLowerCase() ||
		!z.string().email().safeParse(recipient).success ||
		/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)([+@.-])/i.test(recipient)
	)
		return null;
	return recipient;
}
export type VacationSetting = {
	address_id: string;
	enabled: number;
	starts_at: string;
	ends_at: string;
	subject: string;
	body: string;
	repeat_days: number;
	version: number;
};
export async function listVacation(db: D1Database, userId: string) {
	const settings = await db
		.prepare(
			'SELECT address_id,enabled,starts_at,ends_at,subject,body,repeat_days,version FROM vacation_settings WHERE user_id=?'
		)
		.bind(userId)
		.all<VacationSetting>();
	const failures = await db
		.prepare("SELECT count(*) AS n FROM vacation_replies WHERE user_id=? AND state='failed'")
		.bind(userId)
		.first<{ n: number }>();
	return { settings: settings.results, failed: failures?.n ?? 0 };
}
export async function saveVacation(db: D1Database, userId: string, raw: unknown) {
	const parsed = z
		.object({
			addressId: z.string().min(1).max(200),
			enabled: z.boolean(),
			startsAt: z.string().datetime(),
			endsAt: z.string().datetime(),
			subject: z
				.string()
				.trim()
				.min(1)
				.max(200)
				.refine((s) => !/[\r\n]/.test(s)),
			body: z.string().trim().min(1).max(8000),
			repeatDays: z.number().int().min(1).max(30),
			version: z.number().int().min(0)
		})
		.safeParse(raw);
	if (!parsed.success) throw error(400, 'Check the address, dates, subject, and vacation message.');
	const d = parsed.data;
	if (d.endsAt <= d.startsAt || Date.parse(d.endsAt) - Date.parse(d.startsAt) > 366 * 86400000)
		throw error(400, 'Choose a vacation period of up to one year.');
	if (
		!(await db
			.prepare('SELECT id FROM addresses WHERE id=? AND user_id=?')
			.bind(d.addressId, userId)
			.first())
	)
		throw error(404, 'Address not found');
	const result = await db
		.prepare(
			`INSERT INTO vacation_settings(address_id,user_id,enabled,starts_at,ends_at,subject,body,repeat_days,updated_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM vacation_settings WHERE address_id=? AND user_id=?)
    ON CONFLICT(address_id) DO UPDATE SET enabled=excluded.enabled,starts_at=excluded.starts_at,ends_at=excluded.ends_at,subject=excluded.subject,body=excluded.body,
      repeat_days=excluded.repeat_days,updated_at=excluded.updated_at,version=vacation_settings.version+1 WHERE vacation_settings.version=? AND vacation_settings.user_id=?`
		)
		.bind(
			d.addressId,
			userId,
			+d.enabled,
			d.startsAt,
			d.endsAt,
			d.subject,
			d.body,
			d.repeatDays,
			new Date().toISOString(),
			d.version,
			d.addressId,
			userId,
			d.version,
			userId
		)
		.run();
	if (!result.meta.changes) throw error(409, 'Vacation settings changed. Reload before saving.');
	return listVacation(db, userId);
}
type Payload = { outbound: OutboundMailInput; email: Parameters<typeof insertEmail>[1] };
/** Candidate flags are stored with the incoming message, so interrupted ingestion is recoverable. */
export async function processVacation(
	env: { DB: D1Database; ATTACHMENTS: R2Bucket },
	provider: EmailProviderKind
) {
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT e.id,e.user_id,e.address_id,e.vacation_recipient AS recipient,e.message_id,e.subject,e.created_at,
      v.body,v.subject AS reply_subject,v.repeat_days,v.version,a.address,a.domain_id,a.label
    FROM emails e JOIN vacation_settings v ON v.address_id=e.address_id AND v.user_id=e.user_id
    JOIN addresses a ON a.id=e.address_id AND a.user_id=e.user_id
    WHERE e.vacation_processed=0 AND e.vacation_recipient IS NOT NULL AND e.direction='inbound' AND v.enabled=1
      AND e.deleted_at IS NULL AND e.spam_at IS NULL AND datetime(e.created_at)>=datetime(v.starts_at) AND datetime(e.created_at)<datetime(v.ends_at)
      AND datetime(e.created_at)>=datetime(v.updated_at) AND v.ends_at>? AND datetime(e.created_at)<=datetime('now','-1 minute')
      AND lower(e.vacation_recipient) NOT IN (SELECT lower(address) FROM addresses WHERE user_id=e.user_id)
    ORDER BY e.created_at LIMIT 20`
	)
		.bind(now)
		.all<{
			id: string;
			user_id: string;
			address_id: string;
			recipient: string;
			message_id: string | null;
			subject: string;
			created_at: string;
			body: string;
			reply_subject: string;
			repeat_days: number;
			version: number;
			address: string;
			domain_id: string;
			label: string | null;
		}>();
	for (const row of rows.results) {
		const from: MailAddress = {
			id: row.address_id,
			user_id: row.user_id,
			domain_id: row.domain_id,
			domain_name: row.address.split('@')[1],
			address: row.address,
			label: row.label,
			is_default: false,
			signature: null,
			created_at: now
		};
		const outbound = prepareOutboundEmail({
			from,
			senderName: row.label || row.address,
			to: row.recipient,
			subject: row.reply_subject,
			text: row.body,
			inReplyTo: row.message_id,
			headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' }
		});
		const payload: Payload = {
			outbound,
			email: {
				userId: row.user_id,
				direction: 'outbound',
				from: row.address,
				fromName: outbound.senderName,
				to: row.recipient,
				subject: outbound.subject,
				bodyText: outbound.text,
				bodyHtml: outbound.html,
				addressId: row.address_id,
				domainId: row.domain_id,
				replyToEmailId: row.id,
				inReplyTo: row.message_id,
				isRead: true
			}
		};
		await env.DB.batch([
			env.DB.prepare(
				`INSERT OR IGNORE INTO vacation_replies(id,user_id,address_id,source_email_id,recipient,payload_json,created_at)
        SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM vacation_replies WHERE address_id=? AND recipient=? AND created_at>?)
        AND EXISTS(SELECT 1 FROM vacation_settings WHERE address_id=? AND user_id=? AND enabled=1 AND version=? AND ends_at>?)
        AND EXISTS(SELECT 1 FROM emails WHERE id=? AND vacation_processed=0)`
			).bind(
				crypto.randomUUID(),
				row.user_id,
				row.address_id,
				row.id,
				row.recipient,
				JSON.stringify(payload),
				now,
				row.address_id,
				row.recipient,
				new Date(Date.now() - row.repeat_days * 86400000).toISOString(),
				row.address_id,
				row.user_id,
				row.version,
				now,
				row.id
			),
			env.DB.prepare('UPDATE emails SET vacation_processed=1 WHERE id=?').bind(row.id)
		]);
	}
	const pending = await env.DB.prepare(
		"SELECT id,payload_json FROM vacation_replies WHERE state='pending' AND lease_until<? ORDER BY created_at LIMIT 20"
	)
		.bind(Date.now())
		.all<{ id: string; payload_json: string }>();
	for (const row of pending.results) {
		const claim = await env.DB.prepare(
			"UPDATE vacation_replies SET lease_until=?,attempts=attempts+1 WHERE id=? AND state='pending' AND lease_until<?"
		)
			.bind(Date.now() + 300000, row.id, Date.now())
			.run();
		if (!claim.meta.changes) continue;
		try {
			const payload: Payload = JSON.parse(row.payload_json);
			const job = await enqueueOutbound(
				env,
				provider,
				payload.outbound,
				payload.email,
				`vacation/${row.id}`
			);
			await env.DB.prepare(
				"UPDATE vacation_replies SET state='queued',email_id=?,lease_until=0 WHERE id=?"
			)
				.bind(job.id, row.id)
				.run();
		} catch {
			await recordOperationalFailure(
				env.DB,
				'outbound',
				`Vacation reply ${row.id} could not reach Outbox; retrying up to eight times.`
			);
			await env.DB.prepare(
				"UPDATE vacation_replies SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,lease_until=? WHERE id=?"
			)
				.bind(Date.now() + 60000, row.id)
				.run();
		}
	}
}
