import type { D1Database } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { validTimeZone } from '$lib/organizer/dates';
import type { PersonalCalendar } from '$lib/organizer/types';
export async function organizerSettings(db: D1Database, userId: string) {
	const [calendars, prefs] = await Promise.all([
		db
			.prepare(
				`SELECT c.id,c.name,c.color, CASE WHEN c.user_id=? THEN 'owner' ELSE s.permission END AS access FROM personal_calendars c LEFT JOIN calendar_shares s ON s.calendar_id=c.id AND s.user_id=? WHERE c.user_id=? OR s.user_id IS NOT NULL ORDER BY c.name COLLATE NOCASE`
			)
			.bind(userId,userId,userId)
			.all<PersonalCalendar>(),
		db
			.prepare('SELECT time_zone FROM organizer_preferences WHERE user_id = ?')
			.bind(userId)
			.first<{ time_zone: string }>()
	]);
	return { calendars: calendars.results, timeZone: prefs?.time_zone ?? null };
}
export async function saveOrganizerSettings(db: D1Database, userId: string, raw: unknown) {
	const parsed = z
		.object({
			timeZone: z.string().max(100).refine(validTimeZone).optional(),
			calendar: z
				.object({
					name: z
						.string()
						.trim()
						.min(1)
						.max(80)
						.refine((s) => !/[\x00-\x1f]/.test(s)),
					color: z.string().regex(/^#[0-9a-f]{6}$/i),
					id: z.string().max(200).optional()
				})
				.optional()
		})
		.safeParse(raw);
	if (!parsed.success) throw error(400, 'Check the calendar name, color, and time zone.');
	const { timeZone, calendar } = parsed.data;
	if (timeZone)
		await db
			.prepare(
				'INSERT INTO organizer_preferences(user_id, time_zone) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET time_zone = excluded.time_zone'
			)
			.bind(userId, timeZone)
			.run();
	if (calendar) {
		try {
			if (calendar.id) {
				const result = await db
					.prepare('UPDATE personal_calendars SET name = ?, color = ? WHERE id = ? AND user_id = ?')
					.bind(calendar.name, calendar.color, calendar.id, userId)
					.run();
				if (!result.meta.changes) throw error(404, 'Calendar not found');
			} else {
				const result = await db
					.prepare(
						`INSERT INTO personal_calendars(id, user_id, name, color) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM personal_calendars WHERE user_id = ?) < 20`
					)
					.bind(crypto.randomUUID(), userId, calendar.name, calendar.color, userId)
					.run();
				if (!result.meta.changes) throw error(400, 'Create up to 20 calendars.');
			}
		} catch (cause) {
			if (String(cause).includes('UNIQUE'))
				throw error(409, 'A calendar with this name already exists.');
			throw cause;
		}
	}
	return organizerSettings(db, userId);
}
