import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { joinMeeting } from '$lib/server/meetings';
import { organizerBody, organizerJson } from '$lib/server/organizer-http';
export const POST: RequestHandler = async (e) => {
	if (!e.platform?.env.DB) throw error(503, 'Meetings unavailable');
	const user = e.locals.user?.must_change_password ? null : e.locals.user;
	return organizerJson(
		await joinMeeting(
			e.platform.env,
			e.params.id,
			user,
			await organizerBody(e.request, 1024)
		)
	);
};
