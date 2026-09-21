import type { D1Database, D1PreparedStatement, R2Bucket } from '@cloudflare/workers-types';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { MailAddress, User } from '$lib/types';
import type { CalendarEvent, CalendarGuest } from '$lib/organizer/types';
import { Temporal } from '@js-temporal/polyfill';
import { expandEvent, eventReminders } from '$lib/organizer/recurrence';
import { eventTimes } from '$lib/organizer/dates';
import { resolveFromAddress, persistableAddressId } from './outbox';
import { getEmailForUser, insertEmail } from './mail-store';
import { invitationFile } from './calendar-ical';
import { prepareOutboundEmail, type OutboundMailInput } from './send-mail';
import { enqueueOutbound } from './durable-outbox';
import type { EmailProviderKind } from '$lib/types';
import { notifyUser, type PushNotificationEnv } from './push-notifications';

export const remindersInput = z
	.array(z.number().int().min(0).max(10080))
	.max(5)
	.transform((values) => [...new Set(values)].sort((a, b) => a - b));
const field = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
export const eventInput = z.object({
	id: z.string().uuid().optional(),
	version: z.number().int().positive().optional(),
	title: field(180).refine((value) => value.length > 0 && !/[\r\n]/.test(value)),
	description: field(8000).default(''),
	location: field(500).default(''),
	startLocal: z.string().max(30),
	endLocal: z.string().max(30),
	timeZone: z.string().max(100),
	allDay: z.boolean().default(false),
	color: z
		.string()
		.regex(/^#[0-9a-f]{6}$/i)
		.default('#729681'),
	guests: z
		.array(
			z.object({
				email: z
					.string()
					.trim()
					.email()
					.max(254)
					.transform((v) => v.toLowerCase()),
				name: field(200).default('')
			})
		)
		.max(30)
		.default([]),
	fromAddressId: z.string().max(200).nullable().optional(),
	sourceEmailId: z.string().max(200).nullable().optional(),
	reminderMinutes: z.number().int().min(0).max(10080).nullable().default(10),
	reminders: remindersInput.optional(),
	calendarId: z.string().max(200).nullable().optional(),
	recurrence: z
		.object({
			frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
			interval: z.number().int().min(1).max(30),
			count: z.number().int().min(1).max(366)
		})
		.nullable()
		.optional(),
	occurrenceKey: z.string().max(30).optional(),
	scope: z.enum(['this', 'future', 'all']).default('all'),
	resetExceptions: z.boolean().default(false)
});

export async function getCalendarEvent(
	db: D1Database,
	userId: string,
	id: string
): Promise<CalendarEvent | null> {
	const row = await db
		.prepare('SELECT data_json FROM calendar_events WHERE user_id = ? AND id = ?')
		.bind(userId, id)
		.first<{ data_json: string }>();
	return row ? JSON.parse(row.data_json) : null;
}
export async function eventByUid(
	db: D1Database,
	userId: string,
	uid: string
): Promise<CalendarEvent | null> {
	const row = await db
		.prepare('SELECT data_json FROM calendar_events WHERE user_id = ? AND uid = ?')
		.bind(userId, uid)
		.first<{ data_json: string }>();
	return row ? JSON.parse(row.data_json) : null;
}
export async function listCalendarEvents(
	db: D1Database,
	userId: string,
	start: string,
	end: string,
	query = '',
	calendarId = ''
) {
	const a = Date.parse(start),
		b = Date.parse(end);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 370 * 86_400_000)
		throw error(400, 'Choose a calendar range of at most one year.');
	const rows = await db
		.prepare(
			`WITH candidates AS (SELECT id, starts_at, data_json FROM calendar_events WHERE user_id = ? AND cancelled = 0
    AND starts_at < ? AND range_end > ?
    AND (? = '' OR COALESCE(json_extract(data_json, '$.calendarId'), '') = ?)
    ORDER BY starts_at, id LIMIT 201)
    SELECT CASE WHEN SUM(length(CAST(data_json AS BLOB))) OVER (ORDER BY starts_at, id) <= 4194304
      THEN data_json ELSE NULL END AS data_json FROM candidates ORDER BY starts_at, id`
		)
		.bind(
			userId,
			new Date(b).toISOString(),
			new Date(a).toISOString(),
			calendarId,
			calendarId === 'default' ? '' : calendarId
		)
		.all<{ data_json: string | null }>();
	const events: CalendarEvent[] = [];
	let responseBytes = 0;
	let sizeLimited = false;
	const search = query.trim().slice(0, 200).toLowerCase();
	rowsLoop: for (const row of rows.results.slice(0, 200)) {
		if (row.data_json === null) {
			sizeLimited = true;
			break;
		}
		for (const occurrence of expandEvent(JSON.parse(row.data_json))) {
			if (
				Date.parse(occurrence.startsAt) < b &&
				Date.parse(occurrence.endsAt) > a &&
				(!search ||
					[
						occurrence.title,
						occurrence.description,
						occurrence.location,
						...occurrence.guests.map((g) => g.email)
					].some((text) => text.toLowerCase().includes(search)))
			) {
				// Details fetch the full series separately; do not repeat every exception in each row.
				const item = { ...occurrence, exceptions: undefined };
				responseBytes += new TextEncoder().encode(JSON.stringify(item)).length;
				if (responseBytes > 4 * 1024 * 1024) {
					sizeLimited = true;
					break rowsLoop;
				}
				events.push(item);
			}
		}
		if (events.length > 1000) break;
	}
	events.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
	return {
		events: events.slice(0, 1000),
		truncated: sizeLimited || rows.results.length > 200 || events.length > 1000
	};
}

type NoticePayload = { outbound: OutboundMailInput; email: Parameters<typeof insertEmail>[1] };
export function calendarNotice(
	user: User,
	from: MailAddress,
	event: CalendarEvent,
	recipient: string,
	method: 'REQUEST' | 'CANCEL' | 'REPLY',
	reply?: CalendarGuest
): NoticePayload {
	const prefix =
		method === 'CANCEL'
			? 'Cancelled'
			: method === 'REPLY'
				? reply?.status === 'ACCEPTED'
					? 'Accepted'
					: reply?.status === 'DECLINED'
						? 'Declined'
						: 'Tentative'
				: 'Invitation';
	const subject = `${prefix}: ${event.title.replace(/[\r\n]+/g, ' ')}`;
	const when = event.allDay
		? `${event.startLocal} (all day)`
		: `${event.startLocal.replace('T', ' ')} – ${event.endLocal.replace('T', ' ')} (${event.timeZone})`;
	const text = `${subject}\n\n${when}${event.location ? `\nLocation: ${event.location}` : ''}\n\n${event.description}\n\n${method === 'REQUEST' ? 'Open the attached calendar invitation to respond.' : method === 'CANCEL' ? 'This event has been cancelled.' : `${from.address} responded ${reply?.status.toLowerCase()}.`}`;
	const bytes = new TextEncoder().encode(invitationFile(event, method, reply));
	if (bytes.length > 256 * 1024)
		throw error(
			400,
			'This series is too large for one invitation (256 KB). Use fewer occurrences or shorter descriptions.'
		);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const outbound = prepareOutboundEmail({
		from: { ...from, signature: null },
		senderName: from.label || user.name,
		to: recipient,
		subject,
		text,
		attachments: [
			{
				filename: 'invite.ics',
				type: `text/calendar; charset=UTF-8; method=${method}`,
				content: btoa(binary),
				disposition: 'attachment'
			}
		]
	});
	return {
		outbound,
		email: {
			userId: user.id,
			direction: 'outbound',
			from: from.address,
			fromName: outbound.senderName,
			to: recipient,
			subject,
			bodyText: text,
			bodyHtml: outbound.html,
			domainId: from.domain_id,
			addressId: persistableAddressId(from.id),
			isRead: true,
			subjectMatch: false
		}
	};
}

/** One atomic D1 batch commits the event, its immutable notices, and reminder. */
export async function persistCalendarEvent(
	db: D1Database,
	userId: string,
	event: CalendarEvent,
	previous: CalendarEvent | null,
	notices: NoticePayload[] = []
): Promise<CalendarEvent> {
	const mutation = crypto.randomUUID();
	const occurrences = expandEvent(event, true);
	const rangeStart = occurrences.reduce(
		(value, item) => (item.startsAt < value ? item.startsAt : value),
		event.startsAt
	);
	const rangeEnd = occurrences.reduce(
		(value, item) => (item.endsAt > value ? item.endsAt : value),
		event.endsAt
	);
	const statements: D1PreparedStatement[] = [
		previous
			? db
					.prepare(
						`UPDATE calendar_events SET title = ?, starts_at = ?, ends_at = ?,
    range_end = ?, organizer_email = ?, data_json = ?, version = ?, sequence = ?, cancelled = ?, mutation_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND version = ?`
					)
					.bind(
						event.title,
						rangeStart,
						event.endsAt,
						rangeEnd,
						event.organizer.email,
						JSON.stringify(event),
						event.version,
						event.sequence,
						+event.cancelled,
						mutation,
						event.updatedAt,
						event.id,
						userId,
						previous.version
					)
			: db
					.prepare(
						`INSERT INTO calendar_events (id, user_id, uid, title, starts_at, ends_at, range_end, organizer_email, data_json, version, sequence,
      cancelled, mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						event.id,
						userId,
						event.uid,
						event.title,
						rangeStart,
						event.endsAt,
						rangeEnd,
						event.organizer.email,
						JSON.stringify(event),
						event.version,
						event.sequence,
						+event.cancelled,
						mutation,
						event.updatedAt,
						event.updatedAt
					)
	];
	for (const notice of notices)
		statements.push(
			db
				.prepare(
					`INSERT INTO calendar_notices
    (id, user_id, event_id, event_version, recipient, payload_json, created_at)
    SELECT ?, user_id, id, version, ?, ?, ? FROM calendar_events WHERE id = ? AND user_id = ? AND mutation_id = ?`
				)
				.bind(
					crypto.randomUUID(),
					String(notice.outbound.to),
					JSON.stringify(notice),
					event.updatedAt,
					event.id,
					userId,
					mutation
				)
		);
	// One bounded JSON insert handles every occurrence/reminder; unchanged entries retain
	// dismissal, delivery and snooze state through unrelated edits and RSVP updates.
	const reminders =
		!event.cancelled && event.response !== 'DECLINED'
			? occurrences
					.filter((o) => !o.cancelled && Date.parse(o.endsAt) > Date.now())
					.flatMap((o) =>
						eventReminders(event).map((minutes) => ({
							id: crypto.randomUUID(),
							key: o.occurrenceKey || '',
							minutes,
							due: new Date(Date.parse(o.startsAt) - minutes * 60_000).toISOString(),
							title: o.title,
							start: o.startsAt,
							end: o.endsAt
						}))
					)
			: [];
	const guard =
		'EXISTS (SELECT 1 FROM calendar_events WHERE id = ? AND user_id = ? AND mutation_id = ?)';
	const reminderJson = JSON.stringify(reminders);
	statements.push(
		db
			.prepare(
				`DELETE FROM calendar_reminders WHERE event_id = ? AND user_id = ? AND ${guard}
    AND NOT EXISTS (SELECT 1 FROM json_each(?) r WHERE json_extract(r.value, '$.key') = occurrence_key
      AND json_extract(r.value, '$.minutes') = minutes AND json_extract(r.value, '$.start') = starts_at)`
			)
			.bind(event.id, userId, event.id, userId, mutation, reminderJson)
	);
	statements.push(
		db
			.prepare(
				`UPDATE calendar_reminders SET event_version = ? WHERE event_id = ? AND user_id = ? AND ${guard}`
			)
			.bind(event.version, event.id, userId, event.id, userId, mutation)
	);
	statements.push(
		db
			.prepare(
				`INSERT INTO calendar_reminders
    (id, user_id, event_id, event_version, occurrence_key, minutes, due_at, title, starts_at, ends_at)
    SELECT json_extract(value, '$.id'), ?, ?, ?, json_extract(value, '$.key'), json_extract(value, '$.minutes'),
      json_extract(value, '$.due'), json_extract(value, '$.title'), json_extract(value, '$.start'), json_extract(value, '$.end')
    FROM json_each(?) WHERE ${guard}
    ON CONFLICT(event_id, occurrence_key, minutes) DO UPDATE SET title = excluded.title, ends_at = excluded.ends_at`
			)
			.bind(userId, event.id, event.version, reminderJson, event.id, userId, mutation)
	);

	let result;
	try {
		result = await db.batch(statements);
	} catch (cause) {
		if (String(cause).includes('UNIQUE'))
			throw error(409, 'This event already exists. Reload your calendar.');
		throw cause;
	}
	if (!result[0].meta.changes)
		throw error(409, 'This event changed in another tab. Reload before saving.');
	return event;
}

export async function saveCalendarEvent(db: D1Database, user: User, raw: unknown, id?: string) {
	const parsed = eventInput.safeParse(raw);
	if (!parsed.success)
		throw error(400, 'Check the event title, dates, guests, and reminder. Maximum 30 guests.');
	const input = parsed.data;
	const previous = id ? await getCalendarEvent(db, user.id, id) : null;
	if (id && !previous) throw error(404, 'Event not found');
	if (previous && (!previous.owned || previous.cancelled))
		throw error(403, 'Only the organizer can edit an active event.');
	if (previous && input.version !== previous.version)
		throw error(409, 'This event changed. Reload before saving.');
	if (
		input.calendarId &&
		!(await db
			.prepare('SELECT id FROM personal_calendars WHERE id = ? AND user_id = ?')
			.bind(input.calendarId, user.id)
			.first())
	)
		throw error(404, 'Calendar not found');
	if (previous && input.scope !== 'all') return saveOccurrence(db, user, previous, input);
	let dates;
	try {
		dates = eventTimes(input.startLocal, input.endLocal, input.timeZone, input.allDay);
	} catch (cause) {
		throw error(400, cause instanceof Error ? cause.message : 'Invalid event dates');
	}
	let from: MailAddress;
	try {
		from = await resolveFromAddress(db, user, previous?.fromAddressId || input.fromAddressId);
	} catch {
		throw error(400, 'Choose one of your sending addresses in Settings.');
	}
	if (previous && from.address.toLowerCase() !== previous.organizer.email)
		throw error(409, 'The organizing email address is no longer available.');
	if (input.sourceEmailId && !(await getEmailForUser(db, user.id, input.sourceEmailId)))
		throw error(404, 'Source message not found');
	const changedTime =
		previous &&
		(previous.startsAt !== dates.startsAt ||
			previous.endsAt !== dates.endsAt ||
			previous.allDay !== input.allDay);
	const resetExceptions =
		previous &&
		(changedTime ||
			previous.timeZone !== input.timeZone ||
			JSON.stringify(previous.recurrence ?? null) !== JSON.stringify(input.recurrence ?? null));
	if (resetExceptions && Object.keys(previous.exceptions ?? {}).length && !input.resetExceptions)
		throw error(
			400,
			'Changing the series schedule resets occurrence edits. Confirm Reset occurrence edits, or edit this and following events.'
		);
	const seen = new Set<string>([from.address.toLowerCase()]);
	const guests: CalendarGuest[] = input.guests
		.filter((g) => {
			if (seen.has(g.email)) return false;
			seen.add(g.email);
			return true;
		})
		.map((g) => ({
			...g,
			status:
				(!changedTime && previous?.guests.find((old) => old.email === g.email)?.status) ||
				'NEEDS-ACTION'
		}));
	const event: CalendarEvent = {
		...dates,
		title: input.title,
		description: input.description,
		location: input.location,
		startLocal: input.startLocal,
		endLocal: input.endLocal,
		timeZone: input.timeZone,
		allDay: input.allDay,
		color: input.color,
		recurrence: input.recurrence ?? null,
		calendarId: input.calendarId ?? null,
		reminders: input.reminders ?? (input.reminderMinutes === null ? [] : [input.reminderMinutes]),
		reminderMinutes: input.reminders ? (input.reminders[0] ?? null) : input.reminderMinutes,
		exceptions: previous && !resetExceptions ? previous.exceptions : {},
		id: previous?.id ?? input.id ?? crypto.randomUUID(),
		uid: previous?.uid ?? `${crypto.randomUUID()}@quickinbox`,
		organizer: { email: from.address.toLowerCase(), name: from.label || user.name },
		guests,
		owned: true,
		fromAddressId: from.id,
		sourceEmailId: previous?.sourceEmailId ?? input.sourceEmailId ?? null,
		response: 'ACCEPTED',
		version: (previous?.version ?? 0) + 1,
		sequence: previous ? previous.sequence + 1 : 0,
		cancelled: false,
		updatedAt: new Date().toISOString()
	};
	try {
		expandEvent(event);
	} catch (cause) {
		throw error(400, (cause as Error).message);
	}
	const notices = guests.map((guest) => calendarNotice(user, from, event, guest.email, 'REQUEST'));
	for (const removed of previous?.guests.filter((g) => !seen.has(g.email)) ?? [])
		notices.push(
			calendarNotice(
				user,
				from,
				{ ...previous!, sequence: event.sequence, updatedAt: event.updatedAt, cancelled: true },
				removed.email,
				'CANCEL'
			)
		);
	return persistCalendarEvent(db, user.id, event, previous, notices);
}

export async function cancelCalendarEvent(
	db: D1Database,
	user: User,
	id: string,
	version: number,
	scope: 'this' | 'future' | 'all' = 'all',
	occurrenceKey?: string
) {
	const previous = await getCalendarEvent(db, user.id, id);
	if (!previous) throw error(404, 'Event not found');
	if (!previous.owned) throw error(403, 'Respond to the invitation to decline this event.');
	if (version !== previous.version)
		throw error(409, 'This event changed. Reload before cancelling.');
	if (previous.cancelled) return previous;
	if (scope !== 'all') return cancelOccurrence(db, user, previous, scope, occurrenceKey);

	const from = await resolveFromAddress(db, user, previous.fromAddressId);
	if (from.address.toLowerCase() !== previous.organizer.email)
		throw error(409, 'The organizing email address is no longer available.');
	const event = {
		...previous,
		version: previous.version + 1,
		sequence: previous.sequence + 1,
		cancelled: true,
		updatedAt: new Date().toISOString()
	};
	return persistCalendarEvent(
		db,
		user.id,
		event,
		previous,
		event.guests.map((guest) => calendarNotice(user, from, event, guest.email, 'CANCEL'))
	);
}

/** Bounded cron work; immutable payload + notice id makes handoff restart-safe. */
export async function flushCalendarNotices(
	env: { DB: D1Database; ATTACHMENTS: R2Bucket },
	provider: EmailProviderKind,
	userId?: string
) {
	const now = Date.now();
	const rows = await env.DB.prepare(
		`SELECT id, payload_json FROM calendar_notices WHERE state = 'pending' AND next_attempt_at <= ? AND lease_until < ?
    ${userId ? 'AND user_id = ?' : ''} ORDER BY created_at, rowid LIMIT 20`
	)
		.bind(now, now, ...(userId ? [userId] : []))
		.all<{ id: string; payload_json: string }>();
	for (const row of rows.results) {
		const claimed = await env.DB.prepare(
			`UPDATE calendar_notices SET lease_until = ?, attempts = attempts + 1
      WHERE id = ? AND state = 'pending' AND lease_until < ?`
		)
			.bind(now + 300_000, row.id, now)
			.run();
		if (!claimed.meta.changes) continue;
		try {
			const payload: NoticePayload = JSON.parse(row.payload_json);
			const job = await enqueueOutbound(
				env,
				provider,
				payload.outbound,
				payload.email,
				`calendar/${row.id}`
			);
			await env.DB.prepare(
				`UPDATE calendar_notices SET state = 'queued', email_id = ?, lease_until = 0, last_error = NULL WHERE id = ?`
			)
				.bind(job.id, row.id)
				.run();
		} catch {
			await env.DB.prepare(
				`UPDATE calendar_notices SET state = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
        next_attempt_at = ?, lease_until = 0, last_error = 'Invitation could not be added to Outbox. Retry from Calendar.' WHERE id = ?`
			)
				.bind(Date.now() + 300_000, row.id)
				.run();
		}
	}
}

export async function sendCalendarReminders(env: PushNotificationEnv) {
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT r.id, r.user_id, r.event_id, r.title, r.starts_at, r.occurrence_key FROM calendar_reminders r
    JOIN calendar_events e ON e.id = r.event_id AND e.version = r.event_version
    WHERE r.due_at <= ? AND r.notified_at IS NULL AND r.dismissed_at IS NULL AND e.cancelled = 0 AND r.ends_at > ?
    ORDER BY r.due_at LIMIT 50`
	)
		.bind(now, now)
		.all<{
			id: string;
			user_id: string;
			event_id: string;
			title: string;
			starts_at: string;
			occurrence_key: string;
		}>();
	for (const row of rows.results) {
		const claimed = await env.DB.prepare(
			`UPDATE calendar_reminders SET notified_at = ? WHERE id = ? AND notified_at IS NULL
      AND EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = event_id AND e.version = event_version AND e.cancelled = 0)`
		)
			.bind(now, row.id)
			.run();
		if (!claimed.meta.changes) continue;
		await notifyUser(env, row.user_id, {
			title: row.title,
			body: 'Calendar reminder',
			tag: `calendar-${row.id}`,
			url: `/calendar?event=${encodeURIComponent(row.event_id)}&occurrence=${encodeURIComponent(row.occurrence_key)}`
		});
	}
}

function selectOccurrences(
	event: CalendarEvent,
	key: string | undefined,
	scope: 'this' | 'future'
) {
	const occurrences = expandEvent(event, true);
	const index = occurrences.findIndex((o) => o.occurrenceKey === key);
	if (!event.recurrence || index < 0) throw error(400, 'Choose a valid occurrence of this series.');
	return scope === 'this' ? [occurrences[index]] : occurrences.slice(index);
}
async function persistSeriesChange(
	db: D1Database,
	user: User,
	previous: CalendarEvent,
	event: CalendarEvent
) {
	if (JSON.stringify(event).length > 512 * 1024)
		throw error(400, 'This series has too many detailed exceptions. Edit fewer occurrences.');
	const from = await resolveFromAddress(db, user, previous.fromAddressId);
	if (from.address.toLowerCase() !== previous.organizer.email)
		throw error(409, 'The organizing address is no longer available.');
	return persistCalendarEvent(
		db,
		user.id,
		event,
		previous,
		event.guests.map((guest) => calendarNotice(user, from, event, guest.email, 'REQUEST'))
	);
}
async function saveOccurrence(
	db: D1Database,
	user: User,
	previous: CalendarEvent,
	input: z.infer<typeof eventInput>
) {
	if (
		input.timeZone !== previous.timeZone ||
		input.allDay !== previous.allDay ||
		JSON.stringify(input.guests.map((g) => g.email).sort()) !==
			JSON.stringify(previous.guests.map((g) => g.email).sort()) ||
		JSON.stringify(input.recurrence) !== JSON.stringify(previous.recurrence)
	)
		throw error(
			400,
			'Change guests, repeat rules, all-day status, and time zone using All events.'
		);
	try {
		eventTimes(input.startLocal, input.endLocal, previous.timeZone, previous.allDay);
	} catch (cause) {
		throw error(400, (cause as Error).message);
	}
	const affected = selectOccurrences(
		previous,
		input.occurrenceKey,
		input.scope as 'this' | 'future'
	);
	const plain = (value: string) =>
		Temporal.PlainDateTime.from(previous.allDay ? `${value}T00:00` : value);
	const delta = plain(affected[0].startLocal).until(plain(input.startLocal), {
		largestUnit: 'days'
	});
	const duration = plain(input.startLocal).until(plain(input.endLocal), { largestUnit: 'days' });
	const exceptions = { ...previous.exceptions };
	try {
		for (const occurrence of affected) {
			if (occurrence.cancelled) continue;
			const start = plain(occurrence.startLocal).add(delta),
				end = start.add(duration);
			const local = (time: Temporal.PlainDateTime) =>
				previous.allDay
					? time.toPlainDate().toString()
					: time.toString({ smallestUnit: time.second ? 'second' : 'minute' });
			const startLocal = local(start),
				endLocal = local(end);
			eventTimes(startLocal, endLocal, previous.timeZone, previous.allDay);
			exceptions[occurrence.occurrenceKey!] = {
				title: input.title,
				description: input.description,
				location: input.location,
				startLocal,
				endLocal,
				cancelled: false
			};
		}
	} catch (cause) {
		throw error(400, (cause as Error).message);
	}
	return persistSeriesChange(db, user, previous, {
		...previous,
		exceptions,
		version: previous.version + 1,
		sequence: previous.sequence + 1,
		updatedAt: new Date().toISOString()
	});
}
async function cancelOccurrence(
	db: D1Database,
	user: User,
	previous: CalendarEvent,
	scope: 'this' | 'future',
	key?: string
) {
	const exceptions = { ...previous.exceptions };
	for (const o of selectOccurrences(previous, key, scope))
		exceptions[o.occurrenceKey!] = {
			title: o.title,
			description: o.description,
			location: o.location,
			startLocal: o.startLocal,
			endLocal: o.endLocal,
			cancelled: true
		};
	return persistSeriesChange(db, user, previous, {
		...previous,
		exceptions,
		version: previous.version + 1,
		sequence: previous.sequence + 1,
		updatedAt: new Date().toISOString()
	});
}

export async function respondFromCalendar(db: D1Database, user: User, id: string, raw: unknown) {
	const parsed = z
		.object({
			version: z.number().int().positive(),
			response: z.enum(['ACCEPTED', 'TENTATIVE', 'DECLINED'])
		})
		.safeParse(raw);
	if (!parsed.success) throw error(400, 'Choose a response and reload the event.');
	const previous = await getCalendarEvent(db, user.id, id);
	if (!previous) throw error(404, 'Event not found');
	if (previous.owned || previous.cancelled || !previous.organizer.email)
		throw error(400, 'This event is not an active invitation.');
	if (previous.version !== parsed.data.version)
		throw error(409, 'This event changed. Reload before responding.');
	const from = await resolveFromAddress(db, user, previous.fromAddressId);
	const guest = previous.guests.find((g) => g.email === from.address.toLowerCase());
	if (!guest) throw error(403, 'Your address is not an invited guest.');
	if (previous.response === parsed.data.response) return previous;
	const reply = { ...guest, status: parsed.data.response };
	const event = {
		...previous,
		response: parsed.data.response,
		guests: previous.guests.map((g) => (g.email === guest.email ? reply : g)),
		version: previous.version + 1,
		updatedAt: new Date().toISOString()
	};
	return persistCalendarEvent(db, user.id, event, previous, [
		calendarNotice(user, from, event, event.organizer.email, 'REPLY', reply)
	]);
}

export async function actOnReminder(db: D1Database, userId: string, raw: unknown) {
	const parsed = z
		.object({
			id: z.string().min(1).max(200),
			snoozeMinutes: z.number().int().min(1).max(1440).optional()
		})
		.safeParse(raw);
	if (!parsed.success)
		throw error(400, 'Choose a reminder and snooze duration of 1–1,440 minutes.');
	const { id, snoozeMinutes } = parsed.data;
	const now = new Date().toISOString();
	const due = snoozeMinutes ? new Date(Date.now() + snoozeMinutes * 60_000).toISOString() : now;
	const result = await db
		.prepare(
			`UPDATE calendar_reminders SET due_at = CASE WHEN ? THEN ? ELSE due_at END,
    notified_at = CASE WHEN ? THEN NULL ELSE notified_at END, dismissed_at = CASE WHEN ? THEN NULL ELSE ? END
    WHERE id = ? AND user_id = ? AND dismissed_at IS NULL AND due_at <= ? AND ends_at > ?
    AND EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = event_id AND e.version = event_version AND e.cancelled = 0)`
		)
		.bind(
			+(snoozeMinutes !== undefined),
			due,
			+(snoozeMinutes !== undefined),
			+(snoozeMinutes !== undefined),
			now,
			id,
			userId,
			now,
			due
		)
		.run();
	if (!result.meta.changes)
		throw error(409, 'Reminder is no longer active, or snooze would be after the event ends.');
}
