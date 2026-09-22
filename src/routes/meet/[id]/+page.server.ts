import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { meetingForVisitor } from '$lib/server/meetings';
export const load: PageServerLoad = async (e) => {
	if (!e.platform?.env.DB) throw error(503, 'Meetings unavailable');
	const user = e.locals.user?.must_change_password ? null : e.locals.user;
	const meeting = await meetingForVisitor(
		e.platform.env,
		e.params.id,
		user?.id || null
	);
	e.setHeaders({
		'Cache-Control': 'private, no-store',
		'Referrer-Policy': 'no-referrer'
	});
	return {
		meeting: {
			id: meeting.id,
			title: meeting.title,
			audioOnly: !!meeting.audio_only,
			expiresAt: meeting.expires_at,
			guestsAllowed: !!meeting.guests_allowed
		},
		isOwner: user?.id === meeting.owner_id,
		displayName: user?.name || ''
	};
};
