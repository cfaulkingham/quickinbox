import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import { taskReminders, dismissTaskReminder } from '$lib/server/tasks';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson({ reminders: await taskReminders(env.DB, user.id) });
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const raw = (await organizerBody(e.request)) as {
		id?: string;
		version?: number;
		snooze?: boolean;
	};
	if (typeof raw?.id !== 'string' || !Number.isInteger(raw.version))
		throw error(400, 'Reminder and version required');
	await dismissTaskReminder(env.DB, user.id, raw.id, raw.version!, raw.snooze === true);
	return organizerJson({ ok: true });
};
