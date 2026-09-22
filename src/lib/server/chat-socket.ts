import { getAuthenticatedSession, SESSION_COOKIE } from './auth';

/** Upgrade in the Worker wrapper: SvelteKit's response handling is HTTP-only. */
export async function chatSocket(
	request: Request,
	env: Env
): Promise<Response | import('@cloudflare/workers-types').Response> {
	if (env.CHAT_ENABLED === 'false' || !env.CHAT_HUB)
		return new Response('Chat unavailable', { status: 503 });
	if (
		request.method !== 'GET' ||
		request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
	)
		return new Response('WebSocket required', { status: 426 });
	if (request.headers.get('origin') !== new URL(request.url).origin)
		return new Response('Forbidden', { status: 403 });
	const cookie = request.headers
		.get('cookie')
		?.split(';')
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
	let token: string | undefined;
	try {
		token = cookie
			? decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1))
			: undefined;
	} catch {
		return new Response('Unauthorized', { status: 401 });
	}
	const session = await getAuthenticatedSession(env.DB, token);
	if (!session || session.isMobile || session.user.must_change_password)
		return new Response('Unauthorized', { status: 401 });
	return env.CHAT_HUB.getByName(`user:${session.user.id}`).fetch(request.url, {
		headers: {
			Upgrade: 'websocket',
			'X-Chat-User': session.user.id,
			'X-Chat-Session': session.sessionId
		}
	});
}
