import type { PageServerLoad } from './$types';
import { organizerSession } from '$lib/server/organizer-http';
import { searchAttachments } from '$lib/server/attachment-browser';
export const load: PageServerLoad = async (e) => {
	const { env, user } = organizerSession(e),
		q = (e.url.searchParams.get('q') || '').slice(0, 200),
		kind = e.url.searchParams.get('kind') || '',
		offset = Math.max(0, Number(e.url.searchParams.get('offset')) || 0);
	return { q, kind, offset, ...(await searchAttachments(env.DB, user.id, q, offset, kind)) };
};
