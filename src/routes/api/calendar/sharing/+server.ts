import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import {
	calendarSharing,
	setCalendarShare,
	changeCalendarFeed
} from '$lib/server/calendar-sharing';
import { error } from '@sveltejs/kit';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson(
		await calendarSharing(env.DB, user.id, e.url.searchParams.get('calendar') || '')
	);
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const raw = (await organizerBody(e.request)) as { calendarId?: string; feed?: boolean };
	if (typeof raw?.calendarId !== 'string') throw error(400, 'Choose a calendar');
	return organizerJson(
		typeof raw.feed === 'boolean'
			? await changeCalendarFeed(env.DB, user.id, raw.calendarId, raw.feed)
			: await setCalendarShare(env.DB, user.id, raw.calendarId, raw)
	);
};
