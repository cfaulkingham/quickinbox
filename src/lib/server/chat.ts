import { error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { D1Database } from '@cloudflare/workers-types';
import type {
	ChatPerson,
	ChatMessage,
	Conversation,
	ChatEvent
} from '$lib/chat/types';
import { organizerSession } from './organizer-http';
import { notifyUser } from './push-notifications';
import { checkRateLimit } from './auth';

export function chatEnabled(
	env: Pick<App.Platform['env'], 'CHAT_ENABLED'>
): boolean {
	return env.CHAT_ENABLED !== 'false';
}
export function chatSession(e: Pick<RequestEvent, 'locals' | 'platform'>) {
	const result = organizerSession(e);
	if (e.locals.authMethod !== 'session')
		throw error(403, 'Chat requires a browser session');
	if (!chatEnabled(result.env)) throw error(404, 'Chat is disabled');
	return result;
}
export async function requireMember(
	db: D1Database,
	userId: string,
	conversationId: string
) {
	const row = await db
		.prepare(
			'SELECT 1 AS ok FROM chat_members WHERE conversation_id = ? AND user_id = ?'
		)
		.bind(conversationId, userId)
		.first();
	if (!row) throw error(404, 'Conversation not found');
}
export async function chatPeople(db: D1Database, userId: string, search = '') {
	if (!search.trim()) return [];
	const term = `%${search
		.trim()
		.slice(0, 100)
		.replace(/[\\%_]/g, '\\$&')}%`;
	return (
		await db
			.prepare(
				`SELECT id, name, email FROM users WHERE id != ? AND must_change_password = 0
 AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY name, id LIMIT 20`
			)
			.bind(userId, term, term)
			.all<ChatPerson>()
	).results;
}
export async function members(db: D1Database, conversationId: string) {
	return (
		await db
			.prepare(
				`SELECT u.id, u.name, u.email FROM users u JOIN chat_members m ON m.user_id = u.id
 WHERE m.conversation_id = ? ORDER BY u.name, u.id`
			)
			.bind(conversationId)
			.all<ChatPerson>()
	).results;
}
export async function createConversation(
	db: D1Database,
	userId: string,
	input: unknown
) {
	const parsed = z
		.object({
			userIds: z.array(z.string().min(1).max(100)).min(1).max(7),
			title: z.string().trim().max(100).default('')
		})
		.safeParse(input);
	if (!parsed.success)
		throw error(
			400,
			'Choose between one and seven people and a title up to 100 characters'
		);
	const ids = [...new Set([userId, ...parsed.data.userIds])].sort();
	if (ids.length < 2) throw error(400, 'Choose someone else to chat with');
	const found = await db
		.prepare(
			`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')}) AND must_change_password = 0`
		)
		.bind(...ids)
		.all();
	if (found.results.length !== ids.length)
		throw error(400, 'One of these people is unavailable');
	const directKey = ids.length === 2 ? JSON.stringify(ids) : null;
	if (directKey) {
		const existing = await db
			.prepare('SELECT id FROM chat_conversations WHERE direct_key = ?')
			.bind(directKey)
			.first<{ id: string }>();
		if (existing) return existing.id;
	}
	if (!(await checkRateLimit(db, `chat:create:${userId}`, 30, 3600)))
		throw error(429, 'Please wait before starting more conversations');
	const id = crypto.randomUUID();
	// D1 batches are transactional; a racing direct-chat creation resolves to the same room.
	await db.batch([
		db
			.prepare(
				'INSERT INTO chat_conversations (id, direct_key, title, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(direct_key) DO NOTHING'
			)
			.bind(id, directKey, ids.length === 2 ? '' : parsed.data.title, userId),
		...ids.map((member) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO chat_members (conversation_id, user_id)
   SELECT id, ? FROM chat_conversations WHERE ${directKey ? 'direct_key' : 'id'} = ?`
				)
				.bind(member, directKey || id)
		)
	]);
	return (await db
		.prepare(
			`SELECT id FROM chat_conversations WHERE ${directKey ? 'direct_key' : 'id'} = ?`
		)
		.bind(directKey || id)
		.first<{ id: string }>())!.id;
}
export async function listConversations(
	db: D1Database,
	userId: string,
	cursor?: { updatedAt: string; id: string }
): Promise<Conversation[]> {
	const { results } = await db
		.prepare(
			`SELECT c.id, c.title, c.direct_key,
  (SELECT count(*) FROM chat_messages x WHERE x.conversation_id = c.id AND x.seq > m.last_read_seq AND coalesce(x.sender_id, '') != ?) AS unread,
  (SELECT body FROM chat_messages x WHERE x.conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS latest_body,
  coalesce((SELECT created_at FROM chat_messages x WHERE x.conversation_id = c.id ORDER BY seq DESC LIMIT 1), c.created_at) AS updated_at
 FROM chat_conversations c JOIN chat_members m ON m.conversation_id = c.id WHERE m.user_id = ?
 ${cursor ? 'AND (updated_at < ? OR (updated_at = ? AND c.id < ?))' : ''}
 ORDER BY updated_at DESC, c.id DESC LIMIT 50`
		)
		.bind(
			userId,
			userId,
			...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [])
		)
		.all<Omit<Conversation, 'members'>>();
	if (!results.length) return [];
	const people = await db
		.prepare(
			`SELECT m.conversation_id, u.id, u.name, u.email FROM chat_members m
 JOIN users u ON u.id = m.user_id WHERE m.conversation_id IN (${results.map(() => '?').join(',')}) ORDER BY u.name, u.id`
		)
		.bind(...results.map((c) => c.id))
		.all<ChatPerson & { conversation_id: string }>();
	return results.map((c) => ({
		...c,
		members: people.results
			.filter((p) => p.conversation_id === c.id)
			.map(({ conversation_id, ...p }) => p)
	}));
}
export async function unreadCount(
	db: D1Database,
	userId: string
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT count(*) AS unread FROM chat_members m JOIN chat_messages x
 ON x.conversation_id = m.conversation_id AND x.seq > m.last_read_seq WHERE m.user_id = ? AND coalesce(x.sender_id, '') != ?`
		)
		.bind(userId, userId)
		.first<{ unread: number }>();
	return row?.unread || 0;
}
export async function listMessages(
	db: D1Database,
	userId: string,
	id: string,
	before = 0,
	after = 0
) {
	await requireMember(db, userId, id);
	const { results } = await db
		.prepare(
			`SELECT m.*, coalesce(u.name, 'Deleted account') AS sender_name
 FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
 WHERE m.conversation_id = ? AND (? = 0 OR m.seq < ?) AND (? = 0 OR m.seq > ?)
 ORDER BY m.seq ${after ? 'ASC' : 'DESC'} LIMIT 51`
		)
		.bind(id, before, before, after, after)
		.all<ChatMessage>();
	return {
		messages: after ? results.slice(0, 50) : results.slice(0, 50).reverse(),
		hasMore: results.length > 50
	};
}
export async function sendMessage(
	db: D1Database,
	userId: string,
	id: string,
	input: unknown
) {
	await requireMember(db, userId, id);
	const parsed = z
		.object({ id: z.string().uuid(), body: z.string().trim().min(1).max(4000) })
		.safeParse(input);
	if (!parsed.success)
		throw error(400, 'Write a message between 1 and 4,000 characters');
	const existing = await db
		.prepare(
			'SELECT conversation_id, sender_id FROM chat_messages WHERE id = ?'
		)
		.bind(parsed.data.id)
		.first<{ conversation_id: string; sender_id: string }>();
	if (existing) {
		if (existing.conversation_id !== id || existing.sender_id !== userId)
			throw error(409, 'Message ID already used');
		return false;
	}
	// The conditional insert enforces the per-user rate limit atomically.
	const result = await db
		.prepare(
			`INSERT INTO chat_messages (id, conversation_id, sender_id, body)
 SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM chat_messages WHERE sender_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')) < 60
 ON CONFLICT(id) DO NOTHING`
		)
		.bind(parsed.data.id, id, userId, parsed.data.body, userId)
		.run();
	if (!result.meta.changes) {
		const retry = await db
			.prepare(
				'SELECT conversation_id, sender_id FROM chat_messages WHERE id = ?'
			)
			.bind(parsed.data.id)
			.first<{ conversation_id: string; sender_id: string }>();
		if (retry?.conversation_id === id && retry.sender_id === userId)
			return false;
		if (retry) throw error(409, 'Message ID already used');
		throw error(429, 'Please wait a moment before sending another message');
	}
	return true;
}
export async function markRead(
	db: D1Database,
	userId: string,
	id: string,
	seq: number
) {
	await requireMember(db, userId, id);
	if (!Number.isSafeInteger(seq) || seq < 0)
		throw error(400, 'Invalid message position');
	await db
		.prepare(
			`UPDATE chat_members SET last_read_seq = max(last_read_seq, coalesce(
 (SELECT max(seq) FROM chat_messages WHERE conversation_id = ? AND seq <= ?), 0)) WHERE conversation_id = ? AND user_id = ?`
		)
		.bind(id, seq, id, userId)
		.run();
}
export async function publishChat(
	env: App.Platform['env'],
	id: string,
	event: ChatEvent,
	senderId?: string,
	push?: { title: string; body: string; url: string }
) {
	const people = await members(env.DB, id);
	await Promise.all(
		people.map(async (person) => {
			try {
				await env.CHAT_HUB?.getByName(`user:${person.id}`).publish(
					event.type === 'call' && person.id === senderId
						? { type: 'changed', conversationId: id }
						: event
				);
			} catch {
				console.error('Chat live delivery failed');
			}
			if (push && person.id !== senderId)
				await notifyUser(env, person.id, { ...push, tag: `chat-${id}` });
		})
	);
}
