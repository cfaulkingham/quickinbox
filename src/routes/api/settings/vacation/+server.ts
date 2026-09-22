import type { RequestHandler } from './$types';
import { organizerSession, organizerBody, organizerJson } from '$lib/server/organizer-http';
import { listVacation, saveVacation } from '$lib/server/vacation';
export const GET: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson(await listVacation(env.DB, user.id));
};
export const PUT: RequestHandler = async (e) => {
	const { env, user } = organizerSession(e);
	return organizerJson(await saveVacation(env.DB, user.id, await organizerBody(e.request)));
};
