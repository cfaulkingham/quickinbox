import type { RequestHandler } from './$types';
import { organizerSettings, saveOrganizerSettings } from '$lib/server/organizer-settings';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return organizerJson(await organizerSettings(env.DB, user.id));
};
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return organizerJson(
		await saveOrganizerSettings(env.DB, user.id, await organizerBody(event.request))
	);
};
