import { DurableObject } from 'cloudflare:workers';
import type { WebSocket, Request } from '@cloudflare/workers-types';
declare const WebSocketPair: typeof import('@cloudflare/workers-types').WebSocketPair;
declare const Response: typeof import('@cloudflare/workers-types').Response;
import type { ChatEvent } from '../chat/types';

type Connection = { userId: string; sessionId: string; lastTyping: number };

/** One hibernating hub per user, shared by that user's tabs and devices. */
export class ChatHub extends DurableObject<Env> {
	async valid(connection: Connection): Promise<boolean> {
		if (this.env.CHAT_ENABLED === 'false') return false;
		const row = await this.env.DB.prepare(
			`SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id = ? AND s.user_id = ? AND s.device_platform IS NULL AND u.must_change_password = 0
   AND datetime(s.expires_at) > datetime('now')
   AND (NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = u.id) OR s.mfa_verified = 1)`
		)
			.bind(connection.sessionId, connection.userId)
			.first();
		return !!row;
	}
	async fetch(request: Request) {
		const connection: Connection = {
			userId: request.headers.get('X-Chat-User') || '',
			sessionId: request.headers.get('X-Chat-Session') || '',
			lastTyping: 0
		};
		if (!(await this.valid(connection)))
			return new Response('Unauthorized', { status: 401 });
		if (this.ctx.getWebSockets().length >= 8)
			return new Response('Too many open chat tabs', { status: 429 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment(connection);
		await this.ctx.storage.setAlarm(Date.now() + 60_000);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	async publish(event: ChatEvent) {
		const payload = JSON.stringify(event);
		await Promise.all(
			this.ctx.getWebSockets().map(async (socket) => {
				try {
					if (await this.valid(socket.deserializeAttachment() as Connection))
						socket.send(payload);
					else socket.close(1008, 'Session expired');
				} catch {
					socket.close(1011, 'Reconnect');
				}
			})
		);
	}
	async online() {
		for (const socket of this.ctx.getWebSockets()) {
			if (await this.valid(socket.deserializeAttachment() as Connection))
				return true;
		}
		return false;
	}
	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string' || message.length > 256) {
			socket.close(1009, 'Message too large');
			return;
		}
		const connection = socket.deserializeAttachment() as Connection;
		if (!(await this.valid(connection))) {
			socket.close(1008, 'Session expired');
			return;
		}
		if (message === 'ping') {
			socket.send('pong');
			return;
		}
		if (Date.now() - connection.lastTyping < 2500) return;
		let input: { type?: unknown; conversationId?: unknown };
		try {
			input = JSON.parse(message);
		} catch {
			return;
		}
		if (input.type !== 'typing' || typeof input.conversationId !== 'string')
			return;
		const member = await this.env.DB.prepare(
			`SELECT u.name FROM chat_members m JOIN users u ON u.id = m.user_id
   WHERE m.conversation_id = ? AND m.user_id = ?`
		)
			.bind(input.conversationId, connection.userId)
			.first<{ name: string }>();
		if (!member) return;
		connection.lastTyping = Date.now();
		socket.serializeAttachment(connection);
		const peers = await this.env.DB.prepare(
			'SELECT user_id FROM chat_members WHERE conversation_id = ? AND user_id != ?'
		)
			.bind(input.conversationId, connection.userId)
			.all<{ user_id: string }>();
		const event: ChatEvent = {
			type: 'typing',
			conversationId: input.conversationId,
			userId: connection.userId,
			name: member.name
		};
		await Promise.all(
			peers.results.map((p) =>
				this.env.CHAT_HUB?.getByName(`user:${p.user_id}`).publish(event)
			)
		);
	}
	async alarm() {
		for (const socket of this.ctx.getWebSockets()) {
			if (!(await this.valid(socket.deserializeAttachment() as Connection)))
				socket.close(1008, 'Session expired');
		}
		if (this.ctx.getWebSockets().length)
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
	}
	webSocketClose(socket: WebSocket, code: number, reason: string) {
		socket.close(code, reason);
	}
	webSocketError(socket: WebSocket) {
		socket.close(1011, 'Reconnect');
	}
}
