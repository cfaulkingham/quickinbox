import type { RequestHandler } from './$types';
import {
	chatSession,
	createConversation,
	listConversations,
	publishChat,
	unreadCount
} from '$lib/server/chat';
import { organizerBody, organizerJson } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	if (e.url.searchParams.has('unread'))
		return organizerJson({ unread: await unreadCount(env.DB, user.id) });
	const updatedAt = e.url.searchParams.get('before')?.slice(0, 40),
		id = e.url.searchParams.get('id')?.slice(0, 40);
	const conversations = await listConversations(
		env.DB,
		user.id,
		updatedAt && id ? { updatedAt, id } : undefined
	);
	return organizerJson({ conversations, hasMore: conversations.length === 50 });
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	const id = await createConversation(
		env.DB,
		user.id,
		await organizerBody(e.request, 4096)
	);
	e.platform!.ctx.waitUntil(
		publishChat(env, id, { type: 'changed', conversationId: id })
	);
	return organizerJson({ id }, 201);
};
