import type { RequestHandler } from './$types';
import { mergeContacts, duplicateContacts } from '$lib/server/contacts';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return organizerJson({
		contact: await mergeContacts(env.DB, user.id, await organizerBody(event.request))
	});
};

export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return organizerJson({ duplicates: await duplicateContacts(env.DB, user.id) });
};
