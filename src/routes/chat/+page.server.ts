import type { PageServerLoad } from './$types';
import { chatSession, listConversations } from '$lib/server/chat';
import { callsConfigured } from '$lib/server/meetings';
export const load: PageServerLoad = async (e) => {
	const { env, user } = chatSession(e);
	return {
		conversations: await listConversations(env.DB, user.id),
		callsEnabled: callsConfigured(env)
	};
};
