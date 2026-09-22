import type { RequestHandler } from './$types';
import { chatPeople, chatSession } from '$lib/server/chat';
import { organizerJson } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	return organizerJson({
		people: await chatPeople(env.DB, user.id, e.url.searchParams.get('q') || '')
	});
};
