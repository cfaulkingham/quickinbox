import type { RequestHandler } from './$types';
import { listContacts, saveContact, contactGroups } from '$lib/server/contacts';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	const limit = Number(event.url.searchParams.get('limit') || 100),
		offset = Number(event.url.searchParams.get('offset') || 0);
	const groups = await contactGroups(env.DB, user.id);
	const suggestions: { name: string; emails: string[] }[] = [];
	if (event.url.searchParams.get('suggestions') === '1') {
		const query = (event.url.searchParams.get('q') || '').trim().toLowerCase();
		if (query)
			for (const name of groups.filter((g) => g.toLowerCase().includes(query)).slice(0, 4)) {
				const result = await listContacts(env.DB, user.id, '', 31, 0, name);
				const emails = [
					...new Set(result.contacts.flatMap((c) => (c.emails[0] ? [c.emails[0]] : [])))
				];
				if (emails.length && result.total <= 30) suggestions.push({ name, emails });
			}
	}
	return organizerJson({
		...(await listContacts(
			env.DB,
			user.id,
			event.url.searchParams.get('q') || '',
			Number.isFinite(limit) ? Math.min(100, limit) : 100,
			Number.isFinite(offset) ? offset : 0,
			event.url.searchParams.get('group') || '',
			event.url.searchParams.get('favorites') === '1'
		)),
		groups,
		suggestions
	});
};
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return organizerJson(
		{ contact: await saveContact(env.DB, user.id, await organizerBody(event.request)) },
		201
	);
};
