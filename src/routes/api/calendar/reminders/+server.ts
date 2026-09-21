import { actOnReminder } from '$lib/server/calendar';
import type { RequestHandler } from './$types';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT r.id, r.event_id, r.title, r.starts_at, r.occurrence_key FROM calendar_reminders r
    JOIN calendar_events e ON e.id = r.event_id AND e.version = r.event_version
    WHERE r.user_id = ? AND r.due_at <= ? AND r.dismissed_at IS NULL AND e.cancelled = 0 AND r.ends_at > ? ORDER BY r.due_at LIMIT 10`
	)
		.bind(user.id, now, now)
		.all();
	return organizerJson({ reminders: rows.results });
};
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	await actOnReminder(env.DB, user.id, await organizerBody(event.request));
	return organizerJson({ ok: true });
};
