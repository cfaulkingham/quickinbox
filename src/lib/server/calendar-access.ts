import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import type { CalendarEvent } from '$lib/organizer/types';
import { getUserById } from './auth';
export const calendarVisibility = `(e.user_id = ? OR EXISTS (SELECT 1 FROM personal_calendars c LEFT JOIN calendar_shares s ON s.calendar_id=c.id AND s.user_id=? WHERE c.id=json_extract(e.data_json,'$.calendarId') AND (c.user_id=? OR s.user_id IS NOT NULL)))`;
export async function calendarAccess(db: D1Database, userId: string, calendarId: string) {
	return db
		.prepare(
			`SELECT c.user_id, CASE WHEN EXISTS(SELECT 1 FROM calendar_subscriptions WHERE calendar_id=c.id) THEN 'read' WHEN c.user_id=? THEN 'owner' ELSE s.permission END AS access FROM personal_calendars c
   LEFT JOIN calendar_shares s ON s.calendar_id=c.id AND s.user_id=? WHERE c.id=? AND (c.user_id=? OR s.user_id IS NOT NULL)`
		)
		.bind(userId, userId, calendarId, userId)
		.first<{ user_id: string; access: 'owner' | 'read' | 'write' }>();
}
export function visibleEvent(
	event: CalendarEvent,
	shared: boolean,
	access: 'read' | 'write' = 'read'
): CalendarEvent {
	if (!shared) return event;
	return {
		...event,
		shared: true,
		access,
		sourceEmailId: null,
		fromAddressId: null,
		reminders: [],
		reminderMinutes: null
	};
}
export async function accessibleEvent(db: D1Database, userId: string, id: string) {
	const row = await db
		.prepare(
			`SELECT e.user_id,e.data_json FROM calendar_events e WHERE e.id=? AND ${calendarVisibility}`
		)
		.bind(id, userId, userId, userId)
		.first<{ user_id: string; data_json: string }>();
	if (!row) return null;
	const event: CalendarEvent = JSON.parse(row.data_json),
		shared = row.user_id !== userId;
	const access =
		shared && event.calendarId ? await calendarAccess(db, userId, event.calendarId) : null;
	if (shared && !access) return null;
	return {
		event,
		ownerId: row.user_id,
		shared,
		access: (!shared || access?.access === 'owner' || access?.access === 'write'
			? 'write'
			: 'read') as 'read' | 'write'
	};
}
export async function visibleCalendarEvent(db: D1Database, userId: string, id: string) {
	const result = await accessibleEvent(db, userId, id);
	return result ? visibleEvent(result.event, result.shared, result.access) : null;
}
export async function sharedEditor(db: D1Database, userId: string, id: string) {
	const result = await accessibleEvent(db, userId, id);
	if (!result) throw error(404, 'Event not found');
	if (result.access !== 'write') throw error(403, 'This calendar is shared for viewing only.');
	const owner = await getUserById(db, result.ownerId);
	if (!owner) throw error(404, 'Organizer not found');
	return { ...result, owner };
}
