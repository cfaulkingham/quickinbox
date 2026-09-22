import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { testStore } from './testing/store';
import { getEmailForUser, insertEmail } from './mail-store';
import { importMessage } from './mail-import';
import { resolveReplyFromAddress, sendAndStore } from './outbox';
import { sendForwardedMessages } from './forward-mail';
import type { EmailProvider } from './email-provider';
import { hashToken } from './crypto';
import { getAuthenticatedSession, redeemPairingCode, setUserPassword } from './auth';
import { getUserByApiToken } from './api-tokens';
import { getUserByOAuthToken, issueAuthorizationCode, refreshGrant, revokeClientForUser, revokeToken, type TokenResponse } from './oauth';
import { POST as createKey } from '../../routes/api/apikeys/+server';
import { POST as createPairCode } from '../../routes/api/auth/pair-codes/+server';
import { POST as tokenEndpoint } from '../../routes/oauth/token/+server';
import { actions as consent } from '../../routes/oauth/authorize/+page.server';
import { LINKED_SESSIONS_COOKIE } from './constants';

// Inject a real concurrent operation immediately before a matching write, or
// before the whole transaction containing it. Never interleave inside a batch.
function beforeWrite(db: D1Database, pattern: RegExp, action: () => Promise<unknown>): D1Database {
	let pending = true;
	const wrapped = new Map<D1PreparedStatement, { statement: D1PreparedStatement; sql: string }>();
	async function interleave(sql: string) {
		if (pending && pattern.test(sql)) { pending = false; await action(); }
	}
	function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
		const proxy = new Proxy(statement, {
			get(target, key) {
				if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
				if (key === 'run' || key === 'first' || key === 'all') {
					return async (...args: unknown[]) => { await interleave(sql); return Reflect.apply(target[key], target, args); };
				}
				return Reflect.get(target, key);
			}
		});
		wrapped.set(proxy, { statement, sql });
		return proxy;
	}
	return new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
			if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
				for (const statement of statements) await interleave(wrapped.get(statement)?.sql ?? '');
				return target.batch(statements.map((s) => wrapped.get(s)?.statement ?? s));
			};
			return Reflect.get(target, key);
		}
	});
}

async function session(s: ReturnType<typeof testStore>, userId = s.user.id) {
	const id = crypto.randomUUID(), token = crypto.randomUUID();
	s.sqlite.query("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, '2099-01-01')")
		.run(id, userId, await hashToken(token));
	return { id, token };
}

function browserEvent(s: ReturnType<typeof testStore>, sessionId: string, db = s.db) {
	return { locals: { user: s.user, authMethod: 'session', currentSessionId: sessionId }, platform: { env: { ...s.env, DB: db } },
		request: new Request('https://mail.test/api/apikeys', { method: 'POST', body: JSON.stringify({ scopes: ['mail:read', 'mail:send'] }) }) };
}

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const codeInput = { client_id: 'client', redirect_uri: 'https://client.test/callback', code_challenge: challenge,
	scope: ['mail:read', 'mail:send'] as ('mail:read' | 'mail:send')[], resource: 'https://mail.test/mcp' };
async function exchange(db: D1Database, code: string, overrides: Record<string, string> = {}) {
	const request = new Request('https://mail.test/oauth/token', { method: 'POST', body: new URLSearchParams({
		grant_type: 'authorization_code', code, client_id: codeInput.client_id, code_verifier: verifier,
		redirect_uri: codeInput.redirect_uri, ...overrides
	}) });
	return tokenEndpoint({ request, platform: { env: { DB: db } }, url: new URL(request.url), getClientAddress: () => '192.0.2.1' } as never);
}
async function initialGrant(s: ReturnType<typeof testStore>) {
	const actor = await session(s);
	const code = await issueAuthorizationCode(s.db, { ...codeInput, user_id: s.user.id }, actor.id);
	const response = await exchange(s.db, code);
	assert.equal(response.status, 200);
	return response.json() as Promise<TokenResponse>;
}

for (const catchall of [false, true]) for (const folder of ['sent', 'inbox'] as const) {
	test(`imported headers cannot impersonate another mailbox (${folder}, catchall=${catchall})`, async () => {
		const s = testStore();
		try {
			s.sqlite.query('UPDATE domains SET catchall_user_id = ?').run(catchall ? s.user.id : 'user-2');
			s.sqlite.exec("INSERT INTO addresses(id,user_id,domain_id,address) VALUES('victim','user-2','domain-1','victim@example.test')");
			const raw = new TextEncoder().encode('From: Victim <VICTIM@example.test>\r\nTo: Victim <victim@example.test>\r\nSubject: Imported\r\n\r\nHello');
			const imported = await importMessage(s.db, s.bucket, s.user.id, raw, { addressId: s.from.id, folder, labelId: null, path: 'mail.eml', preserveFolders: false });
			const original = (await getEmailForUser(s.db, s.user.id, imported.id))!;
			const from = await resolveReplyFromAddress(s.db, s.user, original);
			assert.equal(from?.address, s.user.email);
			const senders: string[] = [];
			const provider: EmailProvider = { kind: 'cloudflare', async listDomains() { return []; }, async getDomain() { throw new Error('unused'); },
				async send(input) { senders.push(input.from.address); return { providerId: crypto.randomUUID() }; } };
			await sendAndStore(s.env, provider, s.user, { fromAddress: from, to: 'friend@example.test', subject: 'Reply', text: 'Reply', replyToEmailId: original.id });
			await sendForwardedMessages(s.env, provider, s.user, [original], { to: 'friend@example.test' });
			assert.deepEqual(senders, [s.user.email, s.user.email]);
		} finally { s.sqlite.close(); }
	});
}

test('catch-all identity requires native delivery and preserves historical native replies', async () => {
	const s = testStore();
	try {
		const id = await insertEmail(s.db, { userId: s.user.id, direction: 'inbound', from: 'outside@external.test', to: 'alias@example.test', domainId: s.from.domain_id, subject: 'Native' });
		s.sqlite.exec('UPDATE emails SET is_live_inbound = 0'); // Pre-0031 native mail.
		const original = (await getEmailForUser(s.db, s.user.id, id))!;
		assert.equal((await resolveReplyFromAddress(s.db, s.user, original))?.address, 'alias@example.test');
		const sentId = await insertEmail(s.db, { userId: s.user.id, direction: 'outbound', from: 'alias@example.test', to: 'outside@external.test', domainId: s.from.domain_id, subject: 'Reply', status: 'sent' });
		assert.equal((await resolveReplyFromAddress(s.db, s.user, (await getEmailForUser(s.db, s.user.id, sentId))!))?.address, 'alias@example.test');
		const imported = await importMessage(s.db, s.bucket, s.user.id, new TextEncoder().encode('From: alias@example.test\r\nTo: alias@example.test\r\nSubject: Imported\r\n\r\nHello'),
			{ addressId: s.from.id, folder: 'sent', labelId: null, path: 'mail.eml', preserveFolders: false });
		assert.equal((await resolveReplyFromAddress(s.db, s.user, (await getEmailForUser(s.db, s.user.id, imported.id))!))?.address, s.user.email);
		s.sqlite.exec("INSERT INTO addresses(id,user_id,domain_id,address) VALUES('claimed','user-2','domain-1','ALIAS@example.test')");
		assert.equal((await resolveReplyFromAddress(s.db, s.user, original))?.address, s.user.email);
	} finally { s.sqlite.close(); }
});

test('native catch-all Sent mail retains its identity after the received message is permanently deleted', async () => {
	const s = testStore();
	try {
		const receivedId = await insertEmail(s.db, { userId: s.user.id, direction: 'inbound', from: 'outside@external.test', to: 'alias@example.test', domainId: s.from.domain_id, subject: 'Native' });
		const received = (await getEmailForUser(s.db, s.user.id, receivedId))!;
		const from = await resolveReplyFromAddress(s.db, s.user, received);
		const senders: string[] = [];
		const provider: EmailProvider = { kind: 'cloudflare', async listDomains() { return []; }, async getDomain() { throw new Error('unused'); },
			async send(input) { senders.push(input.from.address); return { providerId: crypto.randomUUID() }; } };
		const sent = await sendAndStore(s.env, provider, s.user, { fromAddress: from, to: 'outside@external.test', subject: 'Reply', text: 'Reply', replyToEmailId: receivedId });
		s.sqlite.query('DELETE FROM emails WHERE id = ?').run(receivedId);
		const original = (await getEmailForUser(s.db, s.user.id, sent.emailId))!;
		assert.equal((await resolveReplyFromAddress(s.db, s.user, original))?.address, 'alias@example.test');
		await sendForwardedMessages(s.env, provider, s.user, [original], { to: 'friend@example.test' });
		assert.deepEqual(senders, ['alias@example.test', 'alias@example.test']);
		s.sqlite.exec("INSERT INTO addresses(id,user_id,domain_id,address) VALUES('claimed','user-2','domain-1','alias@example.test')");
		assert.equal((await resolveReplyFromAddress(s.db, s.user, original))?.address, s.user.email);
	} finally { s.sqlite.close(); }
});

for (const kind of ['API key', 'pairing code'] as const) {
	test(`password reset during ${kind} creation cannot leave a usable credential`, async () => {
		const s = testStore();
		try {
			const actor = await session(s);
			const table = kind === 'API key' ? 'api_tokens' : 'pairing_codes';
			const db = beforeWrite(s.db, new RegExp(`INSERT INTO ${table}`), () => setUserPassword(s.db, s.user.id, 'replacement-password'));
			const route = kind === 'API key' ? createKey : createPairCode;
			const response = await route(browserEvent(s, actor.id, db) as never);
			assert.equal(response.status, 401);
			assert.equal(s.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0);
			assert.equal(await getAuthenticatedSession(s.db, actor.token), null);
		} finally { s.sqlite.close(); }
	});
}

test('live browser sessions can create keys and pair devices; revoked sessions cannot', async () => {
	const s = testStore();
	try {
		const actor = await session(s);
		const response = await createKey(browserEvent(s, actor.id) as never);
		assert.equal(response.status, 201);
		const api = await response.json();
		assert.equal((await getUserByApiToken(s.db, api.token))?.user.id, s.user.id);
		const paired = await createPairCode(browserEvent(s, actor.id) as never);
		assert.equal(paired.status, 200);
		const mobile = await redeemPairingCode(s.db, (await paired.json()).code, { name: 'Test device' });
		assert.equal((await getAuthenticatedSession(s.db, mobile!.token))?.isMobile, true);
		s.sqlite.query('DELETE FROM sessions WHERE id = ?').run(actor.id);
		assert.equal((await createKey(browserEvent(s, actor.id) as never)).status, 401);
		assert.equal((await createPairCode(browserEvent(s, actor.id) as never)).status, 401);
	} finally { s.sqlite.close(); }
});

for (const revoke of ['family', 'disconnect', 'password reset'] as const) {
	test(`OAuth refresh cannot survive concurrent ${revoke}`, async () => {
		const s = testStore();
		try {
			const first = await initialGrant(s);
			const db = beforeWrite(s.db, /INSERT INTO oauth_grants/, () => revoke === 'family'
				? revokeToken(s.db, first.refresh_token)
				: revoke === 'disconnect' ? revokeClientForUser(s.db, s.user.id, codeInput.client_id)
				: setUserPassword(s.db, s.user.id, 'replacement-password'));
			await assert.rejects(refreshGrant(db, { refreshToken: first.refresh_token, clientId: codeInput.client_id }), /already used/);
			assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_grants WHERE revoked_at IS NULL').get()!.n, 0);
		} finally { s.sqlite.close(); }
	});
}

test('OAuth rotation narrows scope; replay revokes the successor and a competing refresh has one winner', async () => {
	const s = testStore();
	try {
		const first = await initialGrant(s);
		await assert.rejects(refreshGrant(s.db, { refreshToken: first.refresh_token, clientId: 'other' }), /different client/);
		const second = await refreshGrant(s.db, { refreshToken: first.refresh_token, clientId: codeInput.client_id, scope: 'mail:read' });
		assert.equal(await getUserByOAuthToken(s.db, first.access_token), null);
		assert.deepEqual((await getUserByOAuthToken(s.db, second.access_token))?.scopes, ['mail:read']);
		await assert.rejects(refreshGrant(s.db, { refreshToken: second.refresh_token, clientId: codeInput.client_id, scope: 'mail:read mail:send' }), /not widen/);
		await assert.rejects(refreshGrant(s.db, { refreshToken: first.refresh_token, clientId: codeInput.client_id }), /already used/);
		assert.equal(await getUserByOAuthToken(s.db, second.access_token), null);
		const next = await initialGrant(s);
		const competing = await Promise.allSettled([1, 2].map(() => refreshGrant(s.db, { refreshToken: next.refresh_token, clientId: codeInput.client_id })));
		assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
		assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_grants WHERE revoked_at IS NULL').get()!.n, 0);
	} finally { s.sqlite.close(); }
});

test('failed OAuth rotation rolls back both writes and leaves the original credential usable', async () => {
	const s = testStore();
	try {
		const first = await initialGrant(s);
		s.faults.sql = (sql) => { if (sql.startsWith('UPDATE oauth_grants SET revoked_at')) throw new Error('injected failure'); };
		await assert.rejects(refreshGrant(s.db, { refreshToken: first.refresh_token, clientId: codeInput.client_id }), /injected/);
		s.faults.sql = undefined;
		assert.equal((await getUserByOAuthToken(s.db, first.access_token))?.user.id, s.user.id);
		assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_grants').get()!.n, 1);
	} finally { s.sqlite.close(); }
});

test('password reset blocks late authorization-code issuance', async () => {
	const s = testStore();
	try {
		const actor = await session(s);
		const issuance = beforeWrite(s.db, /INSERT INTO oauth_codes/, () => setUserPassword(s.db, s.user.id, 'replacement-password'));
		await assert.rejects(issueAuthorizationCode(issuance, { ...codeInput, user_id: s.user.id }, actor.id), /session/);
		assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_codes').get()!.n, 0);
	} finally { s.sqlite.close(); }
});

test('password reset blocks an already validated OAuth-code exchange', async () => {
	const s = testStore();
	try {
		const actor = await session(s);
		const code = await issueAuthorizationCode(s.db, { ...codeInput, user_id: s.user.id }, actor.id);
		const exchangeDb = beforeWrite(s.db, /INSERT INTO oauth_grants/, () => setUserPassword(s.db, s.user.id, 'another-password'));
		assert.equal((await exchange(exchangeDb, code)).status, 400);
		assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_grants').get()!.n, 0);
	} finally { s.sqlite.close(); }
});

test('OAuth codes preserve PKCE/client binding, expire at commit, and exchange only once', async () => {
	const s = testStore();
	try {
		const actor = await session(s);
		const issue = () => issueAuthorizationCode(s.db, { ...codeInput, user_id: s.user.id }, actor.id);
		assert.equal((await exchange(s.db, await issue(), { code_verifier: 'a'.repeat(43) })).status, 400);
		assert.equal((await exchange(s.db, await issue(), { client_id: 'other' })).status, 400);
		const expiring = await issue();
		const expiryDb = beforeWrite(s.db, /INSERT INTO oauth_grants/, async () => { s.sqlite.exec("UPDATE oauth_codes SET expires_at='2000-01-01'"); });
		assert.equal((await exchange(expiryDb, expiring)).status, 400);
		const code = await issue();
		const responses = await Promise.all([exchange(s.db, code), exchange(s.db, code)]);
		assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
		const tokens = await responses.find((r) => r.status === 200)!.json();
		assert.equal((await getUserByOAuthToken(s.db, tokens.access_token))?.user.id, s.user.id);
		await revokeClientForUser(s.db, s.user.id, codeInput.client_id);
		assert.equal(await getUserByOAuthToken(s.db, tokens.access_token), null);
	} finally { s.sqlite.close(); }
});

test('OAuth consent uses the chosen linked account session and rejects its concurrent revocation', async () => {
	const s = testStore();
	try {
		const active = await session(s), linked = await session(s, 'user-2');
		s.sqlite.query('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)')
			.run(codeInput.client_id, 'Client', JSON.stringify([codeInput.redirect_uri]), new Date().toISOString());
		async function authorize(db: D1Database) {
			const url = new URL('https://mail.test/oauth/authorize');
			const form = new URLSearchParams({ client_id: codeInput.client_id, redirect_uri: codeInput.redirect_uri, response_type: 'code',
				code_challenge: challenge, scope: 'mail:read', decision: 'allow', user_id: 'user-2' });
			return consent.default!({ ...browserEvent(s, active.id, db), url, fetch,
				request: new Request(url, { method: 'POST', body: form, headers: { origin: url.origin } }),
				cookies: { get: (name: string) => name === LINKED_SESSIONS_COOKIE ? JSON.stringify([linked.token]) : undefined }
			} as never);
		}
		await assert.rejects(authorize(s.db), (error: unknown) => (error as { status: number }).status === 303);
		assert.equal(s.sqlite.query<{ user_id: string }, []>('SELECT user_id FROM oauth_codes').get()!.user_id, 'user-2');
		s.sqlite.exec('DELETE FROM oauth_codes');
		const db = beforeWrite(s.db, /INSERT INTO oauth_codes/, () => setUserPassword(s.db, 'user-2', 'replacement-password'));
		const failure = await authorize(db);
		assert.equal((failure as { status: number }).status, 401);
		assert.equal(s.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM oauth_codes').get()!.n, 0);
	} finally { s.sqlite.close(); }
});
