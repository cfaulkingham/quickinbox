import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { CalendarEvent } from '$lib/organizer/types';
import type { User } from '$lib/types';
import { calendarImportSources, parseInvitation, calendarFile } from './calendar-ical';
import { eventByUid, persistCalendarEvent } from './calendar';
import { resolveFromAddress } from './outbox';

export function previewCalendar(source: string, timeZone: string) {
	let sources: string[];
	try {
		sources = calendarImportSources(source);
	} catch (cause) {
		throw error(400, (cause as Error).message);
	}
	const events: { source: string; title: string; count: number }[] = [],
		issues: { row: number; message: string }[] = [];
	for (const [index, source] of sources.entries()) {
		try {
			const { event, method } = parseInvitation(source, timeZone);
			if (event.cancelled || method === 'CANCEL' || method === 'REPLY')
				throw new Error('Cancelled events and RSVP messages are not imported.');
			events.push({ source, title: event.title, count: event.recurrence?.count ?? 1 });
		} catch (cause) {
			issues.push({ row: index + 1, message: (cause as Error).message });
		}
	}
	return { events, issues };
}
export async function importCalendar(db: D1Database, user: User, raw: unknown) {
	const parsed = z
		.object({
			sources: z
				.array(z.string().max(256 * 1024))
				.min(1)
				.max(10),
			timeZone: z.string().max(100),
			calendarId: z.string().max(200).nullable().default(null)
		})
		.safeParse(raw);
	if (!parsed.success) throw error(400, 'Import up to 10 events or series per batch.');
	const { sources, timeZone, calendarId } = parsed.data;
	if (
		calendarId &&
		!(await db
			.prepare('SELECT id FROM personal_calendars WHERE id = ? AND user_id = ?')
			.bind(calendarId, user.id)
			.first())
	)
		throw error(404, 'Calendar not found');
	const from = await resolveFromAddress(db, user);
	let imported = 0,
		skipped = 0;
	const issues: { row: number; message: string }[] = [];
	for (const [index, source] of sources.entries()) {
		let offered: CalendarEvent;
		try {
			const parsed = parseInvitation(source, timeZone);
			if (parsed.event.cancelled || ['CANCEL', 'REPLY'].includes(parsed.method))
				throw new Error('Not an active event.');
			offered = parsed.event;
		} catch (cause) {
			issues.push({ row: index + 1, message: (cause as Error).message });
			continue;
		}
		if (await eventByUid(db, user.id, offered.uid)) {
			skipped++;
			continue;
		}
		// Imported files are personal copies. They never authorize invitations or replies.
		const event: CalendarEvent = {
			...offered,
			id: crypto.randomUUID(),
			calendarId,
			owned: true,
			fromAddressId: from.id,
			organizer: { email: from.address.toLowerCase(), name: from.label || user.name },
			guests: [],
			response: 'ACCEPTED',
			reminders: [],
			reminderMinutes: null,
			version: 1,
			sequence: 0,
			updatedAt: new Date().toISOString()
		};
		try {
			await persistCalendarEvent(db, user.id, event, null);
			imported++;
		} catch (cause) {
			if (await eventByUid(db, user.id, offered.uid)) skipped++;
			else throw cause;
		}
	}
	return { imported, skipped, issues };
}
export async function exportCalendar(db: D1Database, userId: string, calendarId = '') {
	const rows = await db
		.prepare(
			`WITH candidates AS (SELECT data_json FROM calendar_events WHERE user_id = ? AND cancelled = 0
    AND (? = '' OR COALESCE(json_extract(data_json, '$.calendarId'), '') = ?) ORDER BY starts_at, id LIMIT 501)
    SELECT CASE WHEN SUM(length(CAST(data_json AS BLOB))) OVER () <= 4194304
      THEN data_json ELSE NULL END AS data_json FROM candidates`
		)
		.bind(userId, calendarId, calendarId === 'default' ? '' : calendarId)
		.all<{ data_json: string | null }>();
	if (rows.results.length > 500)
		throw error(400, 'Export up to 500 events or series. Select a smaller calendar.');
	// Bound D1's response before allocating any event JSON in the Worker.
	if (rows.results.some((row) => row.data_json === null))
		throw error(400, 'This export is too large. Select a smaller calendar.');
	return calendarFile(rows.results.map((row) => JSON.parse(row.data_json!)));
}
