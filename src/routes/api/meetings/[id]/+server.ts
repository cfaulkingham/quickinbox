import type { RequestHandler } from './$types';
import { chatSession } from '$lib/server/chat';
import { organizerBody, organizerJson } from '$lib/server/organizer-http';
import { endMeeting } from '$lib/server/meetings';
export const DELETE: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	await organizerBody(e.request, 1024);
	await endMeeting(env, user.id, e.params.id);
	return organizerJson({ ok: true });
};
