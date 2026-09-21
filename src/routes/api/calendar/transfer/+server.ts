import { z } from 'zod';
import type { RequestHandler } from './$types';
import { exportCalendar, importCalendar, previewCalendar } from '$lib/server/calendar-transfer';
import { organizerBody, organizerJson, organizerSession } from '$lib/server/organizer-http';
export const GET: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	return new Response(
		await exportCalendar(env.DB, user.id, event.url.searchParams.get('calendar') || ''),
		{
			headers: {
				'Content-Type': 'text/calendar; charset=utf-8',
				'Content-Disposition': 'attachment; filename="calendar.ics"',
				'Cache-Control': 'private, no-store'
			}
		}
	);
};
export const POST: RequestHandler = async (event) => {
	const { env, user } = organizerSession(event);
	const raw = await organizerBody(event.request, 3 * 1024 * 1024);
	const preview = z
		.object({ source: z.string(), timeZone: z.string().max(100).default('UTC') })
		.safeParse(raw);
	return organizerJson(
		preview.success
			? previewCalendar(preview.data.source, preview.data.timeZone)
			: await importCalendar(env.DB, user, raw)
	);
};
