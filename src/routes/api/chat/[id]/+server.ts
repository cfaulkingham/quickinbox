import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import {
	chatSession,
	listMessages,
	markRead,
	members,
	publishChat,
	sendMessage
} from '$lib/server/chat';
import { organizerBody, organizerJson } from '$lib/server/organizer-http';
import { listMeetings } from '$lib/server/meetings';
export const GET: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	const before = Number(e.url.searchParams.get('before') || 0),
		after = Number(e.url.searchParams.get('after') || 0);
	if (
		![before, after].every((n) => Number.isSafeInteger(n) && n >= 0) ||
		(before && after)
	)
		throw error(400, 'Invalid message position');
	const history = await listMessages(
		env.DB,
		user.id,
		e.params.id,
		before,
		after
	);
	const people = await members(env.DB, e.params.id);
	const conversation = await env.DB.prepare(
		'SELECT id, title, direct_key, created_at AS updated_at FROM chat_conversations WHERE id = ?'
	)
		.bind(e.params.id)
		.first();
	const online = (
		await Promise.all(
			people.map(async (p) => {
				try {
					return (await env.CHAT_HUB?.getByName(`user:${p.id}`).online())
						? p.id
						: null;
				} catch {
					return null;
				}
			})
		)
	).filter(Boolean);
	return organizerJson({
		...history,
		conversation: {
			...conversation,
			members: people,
			unread: 0,
			latest_body: history.messages.at(-1)?.body || null
		},
		people,
		online,
		meetings: await listMeetings(env, user.id, e.params.id)
	});
};
export const POST: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	const inserted = await sendMessage(
		env.DB,
		user.id,
		e.params.id,
		await organizerBody(e.request, 20_000)
	);
	if (inserted)
		e.platform!.ctx.waitUntil(
			publishChat(
				env,
				e.params.id,
				{ type: 'changed', conversationId: e.params.id },
				user.id,
				{
					title: `Message from ${user.name}`,
					body: 'Open Chat to read your message.',
					url: `/chat?conversation=${e.params.id}`
				}
			)
		);
	return organizerJson({ ok: true });
};
export const PATCH: RequestHandler = async (e) => {
	const { env, user } = chatSession(e);
	const body = await organizerBody(e.request, 1024);
	await markRead(
		env.DB,
		user.id,
		e.params.id,
		typeof body === 'object' && body !== null && 'seq' in body
			? Number(body.seq)
			: NaN
	);
	e.platform!.ctx.waitUntil(
		env.CHAT_HUB?.getByName(`user:${user.id}`).publish({
			type: 'changed',
			conversationId: e.params.id
		}) || Promise.resolve()
	);
	return organizerJson({ ok: true });
};
