import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testStore } from './testing/store';
import {
	chatPeople,
	createConversation,
	listConversations,
	listMessages,
	markRead,
	sendMessage,
	unreadCount
} from './chat';
import { chatSocket } from './chat-socket';
import { hashToken } from './crypto';
import {
	callsConfigured,
	createMeeting,
	endMeeting,
	joinMeeting,
	meetingForVisitor,
	closeExpiredMeetings
} from './meetings';
import { organizerBody } from './organizer-http';

test('group conversations retain their title and restrict history to the selected members', async () => {
	const s = testStore();
	s.sqlite
		.query(
			"INSERT INTO users (id, email, name, password_hash, must_change_password) VALUES ('user-3', 'third@test.local', 'Third Person', 'unused', 0)"
		)
		.run();
	const group = await createConversation(s.db, 'user-1', {
		userIds: ['user-2', 'user-3'],
		title: 'Project team'
	});
	const direct = await createConversation(s.db, 'user-1', {
		userIds: ['user-2']
	});
	await sendMessage(s.db, 'user-2', group, {
		id: crypto.randomUUID(),
		body: 'Hello team'
	});
	const rooms = await listConversations(s.db, 'user-3');
	assert.equal(rooms.length, 1);
	assert.equal(rooms[0].id, group);
	assert.equal(rooms[0].title, 'Project team');
	assert.equal(rooms[0].members.length, 3);
	assert.equal(
		(await listMessages(s.db, 'user-3', group)).messages[0].body,
		'Hello team'
	);
	await assert.rejects(listMessages(s.db, 'user-3', direct));
	s.sqlite.close();
});

test('direct conversations converge; messages are private, retry-safe, ordered, and read positions cannot advance beyond actual messages', async () => {
	const s = testStore();
	const first = await createConversation(s.db, 'user-1', {
		userIds: ['user-2']
	});
	assert.equal(
		await createConversation(s.db, 'user-2', { userIds: ['user-1'] }),
		first
	);
	const id = crypto.randomUUID();
	assert.equal(
		await sendMessage(s.db, 'user-1', first, { id, body: ' hello ' }),
		true
	);
	assert.equal(
		await sendMessage(s.db, 'user-1', first, { id, body: 'hello' }),
		false
	);
	assert.equal((await listConversations(s.db, 'user-2'))[0].unread, 1);
	assert.equal((await listConversations(s.db, 'user-1'))[0].unread, 0);
	await assert.rejects(listMessages(s.db, 'stranger', first));
	await assert.rejects(
		sendMessage(s.db, 'stranger', first, {
			id: crypto.randomUUID(),
			body: 'intrusion'
		})
	);
	await assert.rejects(
		sendMessage(s.db, 'user-2', first, { id, body: 'overwrite' })
	);
	const history = await listMessages(s.db, 'user-2', first);
	assert.equal(history.messages.length, 1);
	assert.equal(history.messages[0].body, 'hello');
	await markRead(s.db, 'user-2', first, Number.MAX_SAFE_INTEGER);
	assert.equal((await listConversations(s.db, 'user-2'))[0].unread, 0);
	await sendMessage(s.db, 'user-1', first, {
		id: crypto.randomUUID(),
		body: 'another message'
	});
	assert.equal((await listConversations(s.db, 'user-2'))[0].unread, 1);
	await markRead(s.db, 'user-2', first, 0);
	assert.equal((await listConversations(s.db, 'user-2'))[0].unread, 1);
	assert.deepEqual(await listConversations(s.db, 'stranger'), []);
	s.sqlite.close();
});

test('history pagination has no overlaps; payload and member limits are enforced', async () => {
	const s = testStore(),
		room = await createConversation(s.db, 'user-1', { userIds: ['user-2'] });
	for (let i = 0; i < 55; i++)
		await sendMessage(s.db, 'user-1', room, {
			id: crypto.randomUUID(),
			body: `Message ${i}`
		});
	const latest = await listMessages(s.db, 'user-2', room);
	const older = await listMessages(
		s.db,
		'user-2',
		room,
		latest.messages[0].seq
	);
	assert.equal(latest.hasMore, true);
	assert.equal(latest.messages.length, 50);
	assert.equal(older.hasMore, false);
	assert.equal(older.messages.length, 5);
	assert.ok(older.messages.at(-1)!.seq < latest.messages[0].seq);
	const catchup = await listMessages(
		s.db,
		'user-2',
		room,
		0,
		older.messages[0].seq
	);
	assert.equal(catchup.messages[0].seq, older.messages[1].seq);
	assert.equal(catchup.hasMore, true);
	const remaining = await listMessages(
		s.db,
		'user-2',
		room,
		0,
		catchup.messages.at(-1)!.seq
	);
	assert.equal(remaining.messages.length, 4);
	assert.equal(remaining.hasMore, false);
	assert.equal(await unreadCount(s.db, 'user-2'), 55);
	await assert.rejects(
		sendMessage(s.db, 'user-1', room, {
			id: crypto.randomUUID(),
			body: ' '.repeat(5)
		})
	);
	await assert.rejects(
		sendMessage(s.db, 'user-1', room, {
			id: crypto.randomUUID(),
			body: 'x'.repeat(4001)
		})
	);
	await assert.rejects(
		createConversation(s.db, 'user-1', { userIds: ['missing-user'] })
	);
	await assert.rejects(
		createConversation(s.db, 'user-1', { userIds: ['user-1'] })
	);
	assert.deepEqual(await chatPeople(s.db, 'user-1', '%'), []);
	assert.equal((await chatPeople(s.db, 'user-1', 'Other'))[0].id, 'user-2');
	s.sqlite.close();
});

test('WebSocket authentication decodes cookies and rejects foreign origins, missing sessions, and revoked sessions', async () => {
	const s = testStore(),
		token = 'test+encoded/session=';
	s.sqlite
		.query(
			"INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('chat-session', 'user-1', ?, datetime('now', '+1 day'))"
		)
		.run(await hashToken(token));
	let upgrades = 0;
	const env = {
		...s.env,
		CHAT_HUB: {
			getByName(name: string) {
				assert.equal(name, 'user:user-1');
				return {
					fetch(_url: string, init: RequestInit) {
						upgrades++;
						assert.equal(
							new Headers(init.headers).get('X-Chat-Session'),
							'chat-session'
						);
						return new Response('upgraded');
					}
				};
			}
		}
	} as unknown as Env;
	const request = (
		origin = 'https://mail.test',
		cookie = `mail_session=${encodeURIComponent(token)}`
	) =>
		new Request('https://mail.test/api/chat/socket', {
			headers: { Upgrade: 'websocket', Origin: origin, Cookie: cookie }
		});
	assert.equal((await chatSocket(request(), env)).status, 200);
	assert.equal(
		(await chatSocket(request('https://elsewhere.test'), env)).status,
		403
	);
	assert.equal(
		(await chatSocket(request('https://mail.test', ''), env)).status,
		401
	);
	assert.equal(
		(await chatSocket(request('https://mail.test', 'mail_session=%ZZ'), env))
			.status,
		401
	);
	s.sqlite.query("DELETE FROM sessions WHERE id = 'chat-session'").run();
	assert.equal((await chatSocket(request(), env)).status, 401);
	assert.equal(upgrades, 1);
	s.sqlite.close();
});

test('conversation pagination remains private and unread totals cover every page', async () => {
	const s = testStore();
	for (let i = 0; i < 55; i++) {
		const id = crypto.randomUUID();
		s.sqlite
			.query('INSERT INTO chat_conversations (id, title) VALUES (?, ?)')
			.run(id, `Group ${i}`);
		s.sqlite
			.query(
				'INSERT INTO chat_members (conversation_id, user_id) VALUES (?, ?)'
			)
			.run(id, 'user-1');
		s.sqlite
			.query(
				'INSERT INTO chat_messages (id, conversation_id, sender_id, body) VALUES (?, ?, ?, ?)'
			)
			.run(crypto.randomUUID(), id, 'user-2', 'Hello');
	}
	const first = await listConversations(s.db, 'user-1'),
		last = first.at(-1)!;
	const second = await listConversations(s.db, 'user-1', {
		updatedAt: last.updated_at,
		id: last.id
	});
	assert.equal(first.length, 50);
	assert.equal(second.length, 5);
	assert.equal(new Set([...first, ...second].map((c) => c.id)).size, 55);
	assert.equal(await unreadCount(s.db, 'user-1'), 55);
	assert.equal((await listConversations(s.db, 'user-2')).length, 0);
	s.sqlite.close();
});

test('deleted meeting owners retain provider cleanup records and lose join access immediately', async () => {
	const s = testStore(),
		env = {
			...s.env,
			REALTIME_ACCOUNT_ID: 'a',
			REALTIME_APP_ID: 'b',
			REALTIME_API_TOKEN: 'c',
			REALTIME_PARTICIPANT_PRESET: 'participant'
		};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				success: true,
				data: { id: 'orphan-provider', token: 'token' }
			}),
		{ preconnect: originalFetch.preconnect }
	);
	try {
		const meeting = await createMeeting(env, 'user-1', {
			title: 'Guest',
			guestsAllowed: true
		});
		s.sqlite.query("DELETE FROM users WHERE id = 'user-1'").run();
		const stored = s.sqlite
			.query('SELECT owner_id, provider_id FROM meetings WHERE id = ?')
			.get(meeting.id) as {
			owner_id: string | null;
			provider_id: string | null;
		};
		assert.equal(stored.owner_id, null);
		assert.equal(stored.provider_id, 'orphan-provider');
		await assert.rejects(meetingForVisitor(env, meeting.id, null));
		await closeExpiredMeetings(env);
		assert.equal(
			(
				s.sqlite
					.query('SELECT provider_id FROM meetings WHERE id = ?')
					.get(meeting.id) as { provider_id: string | null }
			).provider_id,
			null
		);
	} finally {
		globalThis.fetch = originalFetch;
		s.sqlite.close();
	}
});

test('JSON writes reject cross-origin requests and bounded bodies', async () => {
	await assert.rejects(
		organizerBody(
			new Request('https://mail.test/api/chat', {
				method: 'POST',
				headers: {
					Origin: 'https://evil.test',
					'Content-Type': 'application/json'
				},
				body: '{}'
			})
		)
	);
	await assert.rejects(
		organizerBody(
			new Request('https://mail.test/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'x'.repeat(100) })
			}),
			30
		)
	);
});

test('meeting authorization, guest opt-in, token roles, expiration, and owner-only shutdown', async () => {
	const s = testStore(),
		room = await createConversation(s.db, 'user-1', { userIds: ['user-2'] });
	const env = {
		...s.env,
		REALTIME_ACCOUNT_ID: 'account',
		REALTIME_APP_ID: 'app',
		REALTIME_API_TOKEN: 'test-secret',
		REALTIME_PARTICIPANT_PRESET: 'participant'
	};
	const originalFetch = globalThis.fetch;
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = (async (url, init) => {
		const path = String(url),
			body = JSON.parse(String(init?.body || '{}'));
		calls.push({ path, body });
		return Response.json({
			success: true,
			data: path.endsWith('/participants')
				? { id: 'participant-id', token: 'participant-token' }
				: { id: `provider-${calls.length}` }
		});
	}) as typeof fetch;
	try {
		assert.equal(callsConfigured(s.env), false);
		await assert.rejects(createMeeting(s.env, 'user-1', { title: 'Test' }));
		const privateMeeting = await createMeeting(env, 'user-1', {
			title: 'Private',
			conversationId: room
		});
		await assert.rejects(meetingForVisitor(env, privateMeeting.id, null));
		await assert.rejects(meetingForVisitor(env, privateMeeting.id, 'stranger'));
		assert.equal(
			(await meetingForVisitor(env, privateMeeting.id, 'user-2')).id,
			privateMeeting.id
		);
		await assert.rejects(endMeeting(env, 'user-2', privateMeeting.id));
		const guestMeeting = await createMeeting(env, 'user-1', {
			title: 'Guest call',
			guestsAllowed: true
		});
		const joined = await joinMeeting(env, guestMeeting.id, null, {
			name: 'Visitor',
			preset: 'host'
		});
		assert.equal(joined.token, 'participant-token');
		assert.equal(calls.at(-1)!.body.preset_name, 'participant');
		assert.equal(calls.at(-1)!.body.name, 'Visitor (guest)');
		assert.ok(!JSON.stringify(guestMeeting).includes('provider-'));
		await endMeeting(env, 'user-1', guestMeeting.id);
		assert.equal(calls.at(-2)!.body.status, 'INACTIVE');
		assert.ok(calls.at(-1)!.path.endsWith('/active-session/kick-all'));
		await assert.rejects(
			joinMeeting(env, guestMeeting.id, null, { name: 'Visitor' })
		);
		s.sqlite
			.query(
				"UPDATE meetings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
			)
			.run(privateMeeting.id);
		await assert.rejects(meetingForVisitor(env, privateMeeting.id, 'user-1'));
		await closeExpiredMeetings(env);
		assert.equal(
			(
				s.sqlite
					.query('SELECT provider_id FROM meetings WHERE id = ?')
					.get(privateMeeting.id) as { provider_id: string | null }
			).provider_id,
			null
		);
	} finally {
		globalThis.fetch = originalFetch;
		s.sqlite.close();
	}
});

test('meeting join attempts are throttled and ending survives provider failure for scheduled retries', async () => {
	const s = testStore(),
		env = {
			...s.env,
			REALTIME_ACCOUNT_ID: 'a',
			REALTIME_APP_ID: 'b',
			REALTIME_API_TOKEN: 'c',
			REALTIME_PARTICIPANT_PRESET: 'participant'
		};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				success: true,
				data: { id: 'provider', token: 'token' }
			}),
		{ preconnect: originalFetch.preconnect }
	);
	try {
		const meeting = await createMeeting(env, 'user-1', {
			title: 'Guest',
			guestsAllowed: true
		});
		for (let i = 0; i < 12; i++)
			await joinMeeting(env, meeting.id, null, { name: 'Visitor' });
		await assert.rejects(
			joinMeeting(env, meeting.id, null, { name: 'Visitor' }),
			(e: unknown) => (e as { status: number }).status === 429
		);
		globalThis.fetch = Object.assign(
			async () => new Response('Unavailable', { status: 503 }),
			{ preconnect: originalFetch.preconnect }
		);
		await assert.rejects(endMeeting(env, 'user-1', meeting.id));
		await assert.rejects(meetingForVisitor(env, meeting.id, 'user-1'));
		assert.ok(
			(
				s.sqlite
					.query('SELECT ended_at FROM meetings WHERE id = ?')
					.get(meeting.id) as { ended_at: string }
			).ended_at
		);
	} finally {
		globalThis.fetch = originalFetch;
		s.sqlite.close();
	}
});
