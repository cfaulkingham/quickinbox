import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readCalendarFeed } from '$lib/server/calendar-sharing';
export const GET: RequestHandler = async (e) => {
	if (!e.platform?.env.DB) throw error(503, 'Calendar unavailable');
	return new Response(await readCalendarFeed(e.platform.env.DB, e.params.token), {
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			'Cache-Control': 'private, no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': 'inline; filename="calendar.ics"'
		}
	});
};
