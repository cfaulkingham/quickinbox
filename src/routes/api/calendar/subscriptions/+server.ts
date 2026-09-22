import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import {
	listSubscriptions,
	addSubscription,
	removeSubscription,
	refreshSubscriptions
} from '$lib/server/calendar-subscriptions';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson({ subscriptions: await listSubscriptions(env.DB, user.id) });
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const id = await addSubscription(env.DB, user.id, await organizerBody(e.request));
	e.platform?.ctx.waitUntil(refreshSubscriptions(env.DB, id));
	return organizerJson({ calendarId: id }, 201);
};
export const DELETE: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	const raw = (await organizerBody(e.request)) as { calendarId?: string };
	if (typeof raw?.calendarId !== 'string') throw error(400, 'Choose a subscription');
	await removeSubscription(env.DB, user.id, raw.calendarId);
	return organizerJson({ ok: true });
};
