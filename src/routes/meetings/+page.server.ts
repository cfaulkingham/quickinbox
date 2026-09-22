import type { PageServerLoad } from './$types';
import { chatSession } from '$lib/server/chat';
import { callsConfigured, listMeetings } from '$lib/server/meetings';
export const load: PageServerLoad = async (e) => {
	const { env, user } = chatSession(e);
	return {
		meetings: await listMeetings(env, user.id),
		callsEnabled: callsConfigured(env)
	};
};
