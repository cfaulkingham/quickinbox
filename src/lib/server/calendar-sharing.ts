import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { calendarFile } from './calendar-ical';
import type { CalendarEvent } from '$lib/organizer/types';
async function ownCalendar(db: D1Database, userId: string, id: string) {
	const calendar = await db
		.prepare('SELECT id,name FROM personal_calendars WHERE id=? AND user_id=?')
		.bind(id, userId)
		.first<{ id: string; name: string }>();
	if (!calendar) throw error(404, 'Calendar not found');
	return calendar;
}
export async function calendarSharing(db: D1Database, userId: string, id: string) {
	await ownCalendar(db, userId, id);
	const shares = await db
		.prepare(
			'SELECT s.user_id,u.email,u.name,s.permission FROM calendar_shares s JOIN users u ON u.id=s.user_id WHERE s.calendar_id=? ORDER BY u.email'
		)
		.bind(id)
		.all();
	const feed = await db
		.prepare('SELECT created_at FROM calendar_feeds WHERE calendar_id=?')
		.bind(id)
		.first();
	return { shares: shares.results, feedEnabled: !!feed };
}
export async function setCalendarShare(db: D1Database, userId: string, id: string, raw: unknown) {
	await ownCalendar(db, userId, id);
	const d = z
		.object({
			email: z
				.string()
				.trim()
				.email()
				.transform((s) => s.toLowerCase()),
			permission: z.enum(['read', 'write', 'remove'])
		})
		.safeParse(raw);
	if (!d.success) throw error(400, 'Enter an account email and a valid permission.');
	const recipient = await db
		.prepare('SELECT id FROM users WHERE lower(email)=?')
		.bind(d.data.email)
		.first<{ id: string }>();
	if (!recipient) throw error(404, 'No account with that sign-in email exists on this server.');
	if (recipient.id === userId) throw error(400, 'You already own this calendar.');
	if (d.data.permission === 'remove')
		await db
			.prepare('DELETE FROM calendar_shares WHERE calendar_id=? AND user_id=?')
			.bind(id, recipient.id)
			.run();
	else {
		if (
			d.data.permission === 'write' &&
			(await db
				.prepare('SELECT 1 FROM calendar_subscriptions WHERE calendar_id=?')
				.bind(id)
				.first())
		)
			throw error(400, 'Subscribed calendars can only be shared for viewing.');
		const result = await db
			.prepare(
				`INSERT INTO calendar_shares(calendar_id,user_id,permission) SELECT ?,?,? WHERE (SELECT count(*) FROM calendar_shares WHERE calendar_id=?)<50 OR EXISTS(SELECT 1 FROM calendar_shares WHERE calendar_id=? AND user_id=?) ON CONFLICT(calendar_id,user_id) DO UPDATE SET permission=excluded.permission`
			)
			.bind(id, recipient.id, d.data.permission, id, id, recipient.id)
			.run();
		if (!result.meta.changes) throw error(400, 'Share with up to 50 accounts.');
	}
	return calendarSharing(db, userId, id);
}
export async function tokenHash(token: string) {
	return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
export async function changeCalendarFeed(
	db: D1Database,
	userId: string,
	id: string,
	enabled: boolean
) {
	await ownCalendar(db, userId, id);
	if (!enabled) {
		await db.prepare('DELETE FROM calendar_feeds WHERE calendar_id=?').bind(id).run();
		return { token: null };
	}
	const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
	await db
		.prepare(
			'INSERT INTO calendar_feeds(calendar_id,token_hash,created_at) VALUES(?,?,?) ON CONFLICT(calendar_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at'
		)
		.bind(id, await tokenHash(token), new Date().toISOString())
		.run();
	return { token };
}
export async function readCalendarFeed(db: D1Database, token: string) {
	if (!/^[a-f0-9]{64}$/.test(token)) throw error(404, 'Calendar feed not found');
	const feed = await db
		.prepare('SELECT calendar_id FROM calendar_feeds WHERE token_hash=?')
		.bind(await tokenHash(token))
		.first<{ calendar_id: string }>();
	if (!feed) throw error(404, 'Calendar feed not found');
	const rows = await db
		.prepare(
			`WITH candidates AS (SELECT data_json FROM calendar_events WHERE json_extract(data_json,'$.calendarId')=? ORDER BY starts_at,id LIMIT 501)
   SELECT CASE WHEN SUM(length(CAST(data_json AS BLOB))) OVER ()<=4194304 THEN data_json ELSE NULL END AS data_json FROM candidates`
		)
		.bind(feed.calendar_id)
		.all<{ data_json: string | null }>();
	if (rows.results.length > 500 || rows.results.some((r) => !r.data_json))
		throw error(413, 'Calendar feed exceeds export limits.');
	return calendarFile(
		rows.results.map((r) => {
			const event: CalendarEvent = JSON.parse(r.data_json!);
			return {
				...event,
				sourceEmailId: null,
				fromAddressId: null,
				reminders: [],
				reminderMinutes: null
			};
		})
	);
}
