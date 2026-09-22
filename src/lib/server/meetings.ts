import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { Meeting } from '$lib/chat/types';
import { chatEnabled, requireMember } from './chat';

type MeetingEnv = Pick<
	App.Platform['env'],
	| 'DB'
	| 'CHAT_ENABLED'
	| 'REALTIME_ACCOUNT_ID'
	| 'REALTIME_APP_ID'
	| 'REALTIME_API_TOKEN'
	| 'REALTIME_PARTICIPANT_PRESET'
>;
type StoredMeeting = Meeting & { provider_id: string | null };
const publicColumns =
	'id, owner_id, conversation_id, title, guests_allowed, audio_only, expires_at, ended_at, created_at';
export function callsConfigured(env: MeetingEnv): boolean {
	return (
		chatEnabled(env) &&
		[
			env.REALTIME_ACCOUNT_ID,
			env.REALTIME_APP_ID,
			env.REALTIME_API_TOKEN,
			env.REALTIME_PARTICIPANT_PRESET
		].every((v) => !!v?.trim())
	);
}
async function realtime(
	env: MeetingEnv,
	path: string,
	method: string,
	body?: unknown,
	allowMissing = false
): Promise<unknown> {
	if (!callsConfigured({ ...env, CHAT_ENABLED: 'true' }))
		throw error(503, 'Calling has not been configured by your administrator');
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.REALTIME_ACCOUNT_ID!)}/realtime/kit/${encodeURIComponent(env.REALTIME_APP_ID!)}/${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${env.REALTIME_API_TOKEN}`,
				'Content-Type': 'application/json'
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		throw error(502, 'The calling service did not respond. Please try again');
	}
	if (allowMissing && response.status === 404) {
		await response.body?.cancel();
		return null;
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw error(
			502,
			'The calling service could not complete the request. Please try again'
		);
	}
	const reader = response.body?.getReader();
	if (!reader) throw error(502, 'Empty response from the calling service');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 128 * 1024) {
				await reader.cancel();
				throw error(502, 'Invalid response from the calling service');
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw error(502, 'Invalid response from the calling service');
	}
	const parsed = z
		.object({ success: z.literal(true), data: z.unknown() })
		.safeParse(decoded);
	if (!parsed.success)
		throw error(502, 'The calling service rejected the request');
	return parsed.data.data;
}
export async function createMeeting(
	env: MeetingEnv,
	userId: string,
	input: unknown
): Promise<Meeting> {
	if (!callsConfigured(env))
		throw error(503, 'Calling has not been configured by your administrator');
	const parsed = z
		.object({
			title: z.string().trim().min(1).max(100),
			conversationId: z.string().uuid().optional(),
			guestsAllowed: z.boolean().default(false),
			audioOnly: z.boolean().default(false),
			expiresAt: z.string().datetime().optional()
		})
		.safeParse(input);
	if (!parsed.success)
		throw error(400, 'Enter a meeting title up to 100 characters');
	const value = parsed.data;
	if (value.conversationId)
		await requireMember(env.DB, userId, value.conversationId);
	if (!value.conversationId && !value.guestsAllowed)
		throw error(400, 'Enable guest links for a standalone meeting');
	const expiresAt =
		value.expiresAt || new Date(Date.now() + 24 * 60 * 60_000).toISOString();
	if (
		Date.parse(expiresAt) < Date.now() + 60_000 ||
		Date.parse(expiresAt) > Date.now() + 31 * 24 * 60 * 60_000
	)
		throw error(400, 'Choose an expiry within the next 31 days');
	const id = [...crypto.getRandomValues(new Uint8Array(24))]
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('');
	const insert = await env.DB.prepare(
		`INSERT INTO meetings (id, owner_id, conversation_id, title, guests_allowed, audio_only, expires_at)
 SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM meetings WHERE owner_id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')) < 20`
	)
		.bind(
			id,
			userId,
			value.conversationId || null,
			value.title,
			Number(value.guestsAllowed),
			Number(value.audioOnly),
			expiresAt,
			userId
		)
		.run();
	if (!insert.meta.changes)
		throw error(429, 'Meeting creation limit reached. Please try again later');
	let providerId: string | null = null;
	try {
		const result = z
			.object({ id: z.string().min(1) })
			.safeParse(
				await realtime(env, 'meetings', 'POST', {
					title: value.title,
					record_on_start: false,
					session_keep_alive_time_in_secs: 60
				})
			);
		if (!result.success) throw error(502, 'Invalid meeting response');
		providerId = result.data.id;
		await env.DB.prepare('UPDATE meetings SET provider_id = ? WHERE id = ?')
			.bind(result.data.id, id)
			.run();
	} catch (cause) {
		// Preserve the provider ID for cron retries if local finalization fails.
		if (providerId) {
			try {
				await env.DB.prepare(
					"UPDATE meetings SET provider_id = ?, ended_at = datetime('now') WHERE id = ?"
				)
					.bind(providerId, id)
					.run();
				await realtime(
					env,
					`meetings/${encodeURIComponent(providerId)}`,
					'PATCH',
					{ status: 'INACTIVE' },
					true
				);
			} catch {
				console.error(
					'Meeting finalization failed; provider cleanup may require a retry'
				);
			}
		}
		await env.DB.prepare(
			"UPDATE meetings SET ended_at = datetime('now') WHERE id = ?"
		)
			.bind(id)
			.run();
		throw cause;
	}
	return (await env.DB.prepare(
		`SELECT ${publicColumns} FROM meetings WHERE id = ?`
	)
		.bind(id)
		.first<Meeting>())!;
}
export async function meetingForVisitor(
	env: MeetingEnv,
	id: string,
	userId: string | null
): Promise<StoredMeeting> {
	if (!chatEnabled(env) || !/^[a-f0-9]{48}$/.test(id))
		throw error(404, 'Meeting not found');
	const meeting = await env.DB.prepare('SELECT * FROM meetings WHERE id = ?')
		.bind(id)
		.first<StoredMeeting>();
	if (!meeting) throw error(404, 'Meeting not found');
	if (!meeting.guests_allowed && meeting.owner_id !== userId) {
		if (!userId || !meeting.conversation_id)
			throw error(404, 'Meeting not found. Sign in with an invited account');
		await requireMember(env.DB, userId, meeting.conversation_id);
	}
	if (
		!meeting.owner_id ||
		(!meeting.guests_allowed && !meeting.conversation_id) ||
		meeting.ended_at ||
		Date.parse(meeting.expires_at) <= Date.now()
	)
		throw error(410, 'This meeting has ended or its link has expired');
	if (!meeting.provider_id) throw error(503, 'This meeting is not ready');
	return meeting;
}
export async function joinMeeting(
	env: MeetingEnv,
	id: string,
	user: { id: string; name: string } | null,
	input: unknown
) {
	if (!callsConfigured(env)) throw error(503, 'Calling is unavailable');
	const meeting = await meetingForVisitor(env, id, user?.id || null);
	const parsed = z
		.object({ name: z.string().trim().min(1).max(80) })
		.safeParse(input);
	if (!parsed.success)
		throw error(400, 'Enter your name (up to 80 characters)');
	// Count all attempts, including failed provider requests. Never accept a preset from the client.
	const admitted = await env.DB.prepare(
		`INSERT INTO meeting_join_attempts (id, meeting_id) SELECT ?, ?
 WHERE EXISTS (SELECT 1 FROM meetings WHERE id = ? AND ended_at IS NULL AND datetime(expires_at) > datetime('now'))
 AND (SELECT count(*) FROM meeting_join_attempts WHERE meeting_id = ? AND created_at > datetime('now','-1 minute')) < 12
 AND (SELECT count(*) FROM meeting_join_attempts WHERE meeting_id = ?) < 200`
	)
		.bind(crypto.randomUUID(), id, id, id, id)
		.run();
	if (!admitted.meta.changes)
		throw error(
			429,
			'This meeting cannot accept another join yet. Please try again later'
		);
	const result = z
		.object({ token: z.string().min(1), id: z.string().min(1) })
		.safeParse(
			await realtime(
				env,
				`meetings/${encodeURIComponent(meeting.provider_id!)}/participants`,
				'POST',
				{
					name: user?.name || `${parsed.data.name} (guest)`,
					preset_name: env.REALTIME_PARTICIPANT_PRESET,
					custom_participant_id: crypto.randomUUID()
				}
			)
		);
	if (!result.success) throw error(502, 'Invalid participant response');
	// Ending a meeting while the provider call is in flight must not release a token.
	await meetingForVisitor(env, id, user?.id || null);
	return { token: result.data.token, audioOnly: !!meeting.audio_only };
}
export async function listMeetings(
	env: MeetingEnv,
	userId: string,
	conversationId?: string
) {
	if (conversationId) await requireMember(env.DB, userId, conversationId);
	return (
		await env.DB.prepare(
			`SELECT ${publicColumns} FROM meetings WHERE ended_at IS NULL AND datetime(expires_at) > datetime('now')
 AND provider_id IS NOT NULL AND owner_id IS NOT NULL AND (guests_allowed = 1 OR conversation_id IS NOT NULL)
 AND (owner_id = ? OR conversation_id IN (SELECT conversation_id FROM chat_members WHERE user_id = ?))
 ${conversationId ? 'AND conversation_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`
		)
			.bind(userId, userId, ...(conversationId ? [conversationId] : []))
			.all<Meeting>()
	).results;
}
async function closeProvider(env: MeetingEnv, meeting: StoredMeeting) {
	if (!meeting.provider_id) return;
	const path = `meetings/${encodeURIComponent(meeting.provider_id)}`;
	await realtime(env, path, 'PATCH', { status: 'INACTIVE' }, true);
	await realtime(env, `${path}/active-session/kick-all`, 'POST', {}, true);
	await env.DB.prepare('UPDATE meetings SET provider_id = NULL WHERE id = ?')
		.bind(meeting.id)
		.run();
}
export async function endMeeting(env: MeetingEnv, userId: string, id: string) {
	const meeting = await env.DB.prepare(
		'SELECT * FROM meetings WHERE id = ? AND owner_id = ?'
	)
		.bind(id, userId)
		.first<StoredMeeting>();
	if (!meeting) throw error(404, 'Meeting not found');
	await env.DB.prepare(
		"UPDATE meetings SET ended_at = coalesce(ended_at, datetime('now')) WHERE id = ?"
	)
		.bind(id)
		.run();
	await closeProvider(env, meeting);
}
export async function closeExpiredMeetings(env: MeetingEnv) {
	const rows = await env.DB.prepare(
		`SELECT * FROM meetings WHERE provider_id IS NOT NULL AND
 (ended_at IS NOT NULL OR owner_id IS NULL OR (guests_allowed = 0 AND conversation_id IS NULL)
 OR datetime(expires_at) <= datetime('now') OR ? = 'false') LIMIT 10`
	)
		.bind(env.CHAT_ENABLED || 'true')
		.all<StoredMeeting>();
	for (const meeting of rows.results) {
		try {
			await env.DB.prepare(
				"UPDATE meetings SET ended_at = coalesce(ended_at, datetime('now')) WHERE id = ?"
			)
				.bind(meeting.id)
				.run();
			await closeProvider(env, meeting);
		} catch {
			console.error('Meeting cleanup failed; will retry');
		}
	}
	await env.DB.prepare(
		"DELETE FROM meeting_join_attempts WHERE meeting_id IN (SELECT id FROM meetings WHERE provider_id IS NULL AND (ended_at IS NOT NULL OR datetime(expires_at) <= datetime('now')))"
	).run();
}
