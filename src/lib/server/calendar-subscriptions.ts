import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { calendarImportSources, parseInvitation } from './calendar-ical';
import { expandEvent } from '$lib/organizer/recurrence';
import type { CalendarEvent } from '$lib/organizer/types';
import { tokenHash } from './calendar-sharing';
type FetchCalendar = (url: string, init?: RequestInit) => Promise<Response>;
export function subscriptionUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value.replace(/^webcal:/i, 'https:'));
	} catch {
		throw error(400, 'Enter an HTTPS calendar URL.');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.port ||
		!url.hostname.includes('.') ||
		/[\[\]:]/.test(url.hostname) ||
		/^\d+(\.\d+)*$/.test(url.hostname) ||
		/(^|\.)(localhost|local|internal|test|invalid|home|lan)$/.test(url.hostname)
	)
		throw error(400, 'Use a public HTTPS calendar URL without credentials or a custom port.');
	url.hash = '';
	return url.toString();
}
export async function listSubscriptions(db: D1Database, userId: string) {
	return (
		await db
			.prepare(
				'SELECT s.calendar_id,c.name,s.last_success,s.last_error FROM calendar_subscriptions s JOIN personal_calendars c ON c.id=s.calendar_id WHERE s.user_id=? ORDER BY c.name'
			)
			.bind(userId)
			.all()
	).results;
}
export async function addSubscription(db: D1Database, userId: string, raw: unknown) {
	const parsed = z
		.object({ name: z.string().trim().min(1).max(80), url: z.string().max(2048) })
		.safeParse(raw);
	if (!parsed.success) throw error(400, 'Enter a calendar name and URL.');
	const url = subscriptionUrl(parsed.data.url),
		id = crypto.randomUUID();
	try {
		const results = await db.batch([
			db
				.prepare(
					'INSERT INTO personal_calendars(id,user_id,name,color) SELECT ?,?,?,? WHERE (SELECT count(*) FROM personal_calendars WHERE user_id=?)<20'
				)
				.bind(id, userId, parsed.data.name, '#6a8fb3', userId),
			db
				.prepare(
					'INSERT INTO calendar_subscriptions(calendar_id,user_id,url) SELECT id,user_id,? FROM personal_calendars WHERE id=? AND user_id=?'
				)
				.bind(url, id, userId)
		]);
		if (!results[0].meta.changes) throw error(400, 'Create up to 20 calendars.');
	} catch (cause) {
		if (String(cause).includes('UNIQUE'))
			throw error(409, 'A calendar with this name already exists.');
		throw cause;
	}
	return id;
}
export async function removeSubscription(db: D1Database, userId: string, id: string) {
	await db.batch([
		db
			.prepare(
				`DELETE FROM calendar_events WHERE user_id=? AND json_extract(data_json,'$.calendarId')=? AND EXISTS(SELECT 1 FROM calendar_subscriptions WHERE calendar_id=? AND user_id=?)`
			)
			.bind(userId, id, id, userId),
		db
			.prepare(
				'DELETE FROM personal_calendars WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM calendar_subscriptions WHERE calendar_id=? AND user_id=?)'
			)
			.bind(id, userId, id, userId)
	]);
}
export async function fetchCalendarSource(url: string, fetcher: FetchCalendar = fetch) {
	let target = subscriptionUrl(url);
	for (let redirect = 0; redirect < 4; redirect++) {
		const response = await fetcher(target, {
			redirect: 'manual',
			signal: AbortSignal.timeout(10000),
			headers: { Accept: 'text/calendar' }
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			const location = response.headers.get('location');
			if (!location) throw new Error('Calendar redirect has no destination.');
			target = subscriptionUrl(new URL(location, target).toString());
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Calendar server returned HTTP ${response.status}.`);
		}
		if (!response.body) throw new Error('Calendar server returned an empty response.');
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 2 * 1024 * 1024) {
					await reader.cancel();
					throw new Error('Calendar exceeds the 2 MB subscription limit.');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return new TextDecoder().decode(bytes);
	}
	throw new Error('Calendar redirected too many times.');
}
export async function refreshSubscriptions(
	db: D1Database,
	onlyId?: string,
	fetcher: FetchCalendar = fetch
) {
	const now = Date.now();
	const rows = await db
		.prepare(
			`SELECT calendar_id,user_id,url FROM calendar_subscriptions WHERE lease_until<? AND ${onlyId ? 'calendar_id=?' : 'next_refresh<?'} ORDER BY next_refresh LIMIT 3`
		)
		.bind(now, onlyId ?? now)
		.all<{ calendar_id: string; user_id: string; url: string }>();
	for (const row of rows.results) {
		const lease = now + 300000;
		const claim = await db
			.prepare(
				'UPDATE calendar_subscriptions SET lease_until=? WHERE calendar_id=? AND lease_until<?'
			)
			.bind(lease, row.calendar_id, now)
			.run();
		if (!claim.meta.changes) continue;
		try {
			const source = await fetchCalendarSource(row.url, fetcher);
			const sources = calendarImportSources(source, true);
			const events: CalendarEvent[] = [];
			const seen = new Set<string>();
			for (const source of sources) {
				const parsed = parseInvitation(source, 'UTC');
				if (['REPLY', 'CANCEL'].includes(parsed.method) || parsed.event.cancelled) continue;
				const item = parsed.event;
				if (seen.has(item.uid)) throw new Error('Calendar contains duplicate event identifiers.');
				seen.add(item.uid);
				const id = (await tokenHash(`${row.calendar_id}\n${item.uid}`)).slice(0, 32);
				events.push({
					...item,
					id,
					uid: `${row.calendar_id}/${item.uid}`,
					calendarId: row.calendar_id,
					owned: false,
					subscription: true,
					sourceEmailId: null,
					fromAddressId: null,
					reminders: [],
					reminderMinutes: null,
					response: 'ACCEPTED',
					version: 1
				});
			}
			if (events.length > 500)
				throw new Error('Subscribe to calendars with up to 500 events or series.');
			const snapshots = events.map((e) => {
				const expanded = expandEvent(e, true);
				return {
					id: e.id,
					uid: e.uid,
					title: e.title,
					start: expanded.reduce((s, o) => (o.startsAt < s ? o.startsAt : s), e.startsAt),
					end: e.endsAt,
					range: expanded.reduce((s, o) => (o.endsAt > s ? o.endsAt : s), e.endsAt),
					organizer: e.organizer.email,
					json: JSON.stringify(e)
				};
			});
			const serialized = JSON.stringify(snapshots);
			if (new TextEncoder().encode(serialized).length > 4 * 1024 * 1024)
				throw new Error('Expanded calendar exceeds storage limits.');
			const stamp = new Date().toISOString();
			await db.batch([
				db
					.prepare(
						`DELETE FROM calendar_events WHERE user_id=? AND json_extract(data_json,'$.calendarId')=? AND NOT EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.id')=calendar_events.id) AND EXISTS(SELECT 1 FROM calendar_subscriptions WHERE calendar_id=? AND lease_until=?)`
					)
					.bind(row.user_id, row.calendar_id, serialized, row.calendar_id, lease),
				db
					.prepare(
						`INSERT INTO calendar_events(id,user_id,uid,title,starts_at,ends_at,range_end,organizer_email,data_json,version,sequence,cancelled,mutation_id,created_at,updated_at)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.uid'),json_extract(value,'$.title'),json_extract(value,'$.start'),json_extract(value,'$.end'),json_extract(value,'$.range'),json_extract(value,'$.organizer'),json_extract(value,'$.json'),1,0,0,?,?,?
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM calendar_subscriptions WHERE calendar_id=? AND user_id=? AND lease_until=?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,range_end=excluded.range_end,data_json=excluded.data_json,updated_at=excluded.updated_at`
					)
					.bind(
						row.user_id,
						crypto.randomUUID(),
						stamp,
						stamp,
						serialized,
						row.calendar_id,
						row.user_id,
						lease
					),
				db
					.prepare(
						'UPDATE calendar_subscriptions SET lease_until=0,next_refresh=?,last_success=?,last_error=NULL WHERE calendar_id=? AND lease_until=?'
					)
					.bind(now + 3600000, stamp, row.calendar_id, lease)
			]);
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : 'Calendar refresh failed.';
			// Never persist the private subscription URL in errors or logs.
			const safe =
				/Calendar |calendar |recurr|Repeat |series|Unsupported |Invitation |invitation /i.test(
					detail
				) && !detail.includes('://')
					? detail.slice(0, 240)
					: 'Calendar refresh failed. Check the URL and feed format.';
			await db
				.prepare(
					'UPDATE calendar_subscriptions SET lease_until=0,next_refresh=?,last_error=? WHERE calendar_id=? AND lease_until=?'
				)
				.bind(now + 3600000, safe, row.calendar_id, lease)
				.run();
		}
	}
}
