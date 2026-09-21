import ICAL from 'ical.js';
import { Temporal } from '@js-temporal/polyfill';
import type { CalendarEvent, CalendarGuest } from '$lib/organizer/types';
import { eventTimes, localTime, validTimeZone } from '$lib/organizer/dates';
import { z } from 'zod';
import { expandEvent, parseRecurrence, recurrenceRule } from '$lib/organizer/recurrence';

const address = z.string().email().max(254);
const attendance = new Set(['NEEDS-ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED']);
function email(value: unknown): string {
	const parsed = address.safeParse(
		String(value ?? '')
			.replace(/^mailto:/i, '')
			.toLowerCase()
	);
	if (!parsed.success) throw new Error('The invitation contains an invalid email address.');
	return parsed.data;
}
function string(component: ICAL.Component, name: string, max: number, fallback = '') {
	const value = String(component.getFirstPropertyValue(name) ?? fallback);
	if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
		throw new Error('Invitation fields exceed supported limits.');
	return value;
}

/** Parse only a bounded, single occurrence. Never fetch URLs or execute alarms. */
function parseSingleInvitation(
	source: string,
	fallbackZone = 'UTC',
	allowException = false
): { event: CalendarEvent; method: string } {
	if (new TextEncoder().encode(source).length > 256 * 1024)
		throw new Error('Calendar file is too large (maximum 256 KB).');
	// Bound nesting before entering the library parser.
	let depth = 0;
	for (const line of source.split(/\r?\n/)) {
		if (/^BEGIN:/i.test(line) && ++depth > 8)
			throw new Error('Calendar file is nested too deeply.');
		if (/^END:/i.test(line)) depth--;
		if (depth < 0) throw new Error('Invalid calendar file.');
	}
	if (depth !== 0) throw new Error('Invalid calendar file.');
	const root = new ICAL.Component(ICAL.parse(source));
	if (root.name !== 'vcalendar') throw new Error('Expected an iCalendar file.');
	const parts = root.getAllSubcomponents('vevent');
	if (parts.length !== 1) throw new Error('Open a calendar file containing one event.');
	const item = parts[0];
	if (
		item.hasProperty('rdate') ||
		item.hasProperty('exrule') ||
		(!allowException && item.hasProperty('recurrence-id'))
	) {
		throw new Error(
			'This recurring invitation uses unsupported recurrence properties. Download it to preserve the complete series.'
		);
	}
	const rule = item.getFirstPropertyValue('rrule');
	const recurrence = rule ? parseRecurrence(String(rule)) : null;

	const method = string(root, 'method', 30, 'PUBLISH').toUpperCase();
	if (!['REQUEST', 'REPLY', 'CANCEL', 'PUBLISH'].includes(method))
		throw new Error('This calendar message type is not supported.');
	const uid = string(item, 'uid', 512);
	if (!uid || /[\r\n]/.test(uid)) throw new Error('Invitation has no valid event identifier.');
	const start = item.getFirstPropertyValue('dtstart') as ICAL.Time | null;
	let end = item.getFirstPropertyValue('dtend') as ICAL.Time | null;
	if (!start) throw new Error('Invitation has no start time.');
	if (!end && item.hasProperty('duration')) {
		end = start.clone();
		end.addDuration(item.getFirstPropertyValue('duration') as ICAL.Duration);
	}
	if (!end && start.isDate) {
		end = start.clone();
		end.adjust(1, 0, 0, 0);
	}
	if (!end || start.isDate !== end.isDate) throw new Error('Invitation has no valid end time.');
	const zoneParam = String(item.getFirstProperty('dtstart')?.getParameter('tzid') ?? '');
	if (recurrence && zoneParam && !validTimeZone(zoneParam))
		throw new Error('Recurring invitations require an IANA time zone.');
	const zone =
		start.zone === ICAL.Timezone.utcTimezone
			? 'UTC'
			: validTimeZone(zoneParam)
				? zoneParam
				: validTimeZone(fallbackZone)
					? fallbackZone
					: 'UTC';
	function instant(time: ICAL.Time, property: string): string {
		const tzid = String(item.getFirstProperty(property)?.getParameter('tzid') ?? zoneParam);
		const local = time.toString().replace(/Z$/, '');
		if (time.isDate)
			return eventTimes(
				local,
				Temporal.PlainDate.from(local).add({ days: 1 }).toString(),
				zone,
				true
			).startsAt;
		if (time.zone === ICAL.Timezone.utcTimezone || /Z$/.test(time.toString()))
			return new Date(time.toJSDate()).toISOString();
		const embedded = tzid ? root.getTimeZoneByID(tzid) : null;
		if (embedded) {
			const zoned = ICAL.Time.fromString(local, item.getFirstProperty(property)!);
			zoned.zone = embedded;
			return zoned.toJSDate().toISOString();
		}
		if (tzid && !validTimeZone(tzid))
			throw new Error(`Unsupported invitation time zone: ${tzid.slice(0, 80)}`);
		return new Date(
			Temporal.PlainDateTime.from(local).toZonedDateTime(tzid || zone, { disambiguation: 'reject' })
				.epochMilliseconds
		).toISOString();
	}
	const startsAt = instant(start, 'dtstart');
	const endsAt = instant(end, 'dtend');
	if (
		endsAt <= startsAt ||
		Date.parse(endsAt) - Date.parse(startsAt) > 366 * 86_400_000 ||
		Number(startsAt.slice(0, 4)) < 1970 ||
		Number(endsAt.slice(0, 4)) > 2100
	)
		throw new Error('Invitation dates are outside supported limits.');
	const organizer = item.getFirstProperty('organizer');
	const guests: CalendarGuest[] = item.getAllProperties('attendee').map((prop) => {
		const status = String(prop.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase();
		return {
			email: email(prop.getFirstValue()),
			name: String(prop.getParameter('cn') ?? '').slice(0, 200),
			status: attendance.has(status) ? (status as CalendarGuest['status']) : 'NEEDS-ACTION'
		};
	});
	if (guests.length > 50 || new Set(guests.map((g) => g.email)).size !== guests.length)
		throw new Error('Invitation has too many or duplicate guests.');
	const sequence = Number(item.getFirstPropertyValue('sequence') ?? 0);
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 1_000_000)
		throw new Error('Invalid invitation revision.');
	return {
		method,
		event: {
			id: '',
			uid,
			recurrence,
			exceptions: {},
			title: string(item, 'summary', 180, 'Untitled event'),
			description: string(item, 'description', 8000),
			location: string(item, 'location', 500),
			startsAt,
			endsAt,
			startLocal: start.isDate ? start.toString() : localTime(startsAt, zone),
			endLocal: end.isDate ? end.toString() : localTime(endsAt, zone),
			timeZone: zone,
			allDay: start.isDate,
			color: '#729681',
			organizer: {
				email: organizer ? email(organizer.getFirstValue()) : '',
				name: String(organizer?.getParameter('cn') ?? '').slice(0, 200)
			},
			guests,
			owned: false,
			fromAddressId: null,
			sourceEmailId: null,
			response: 'NEEDS-ACTION',
			reminderMinutes: 10,
			version: 0,
			sequence,
			cancelled: method === 'CANCEL' || item.getFirstPropertyValue('status') === 'CANCELLED',
			updatedAt: new Date().toISOString()
		}
	};
}

export function invitationFile(
	event: CalendarEvent,
	method: 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH',
	reply?: CalendarGuest
): string {
	const root = new ICAL.Component('vcalendar');
	root.addPropertyWithValue('version', '2.0');
	root.addPropertyWithValue('prodid', '-//Quickinbox//Calendar//EN');
	root.addPropertyWithValue('method', method);
	const item = new ICAL.Component('vevent');
	root.addSubcomponent(item);
	for (const [key, value] of Object.entries({
		uid: event.uid,
		summary: event.title,
		description: event.description,
		location: event.location,
		sequence: event.sequence,
		status: method === 'CANCEL' || event.cancelled ? 'CANCELLED' : 'CONFIRMED'
	}))
		item.addPropertyWithValue(key, value);
	item.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(event.updatedAt), true));
	for (const [key, local, instant] of [
		['dtstart', event.startLocal, event.startsAt],
		['dtend', event.endLocal, event.endsAt]
	]) {
		const prop = new ICAL.Property(key);
		prop.setValue(
			event.allDay
				? ICAL.Time.fromDateString(local)
				: event.recurrence
					? ICAL.Time.fromString(local.length === 16 ? `${local}:00` : local, prop)
					: ICAL.Time.fromJSDate(new Date(instant), true)
		);
		if (event.recurrence && !event.allDay) prop.setParameter('tzid', event.timeZone);
		item.addProperty(prop);
	}
	if (event.recurrence)
		item.addPropertyWithValue('rrule', ICAL.Recur.fromString(recurrenceRule(event.recurrence)));

	if (event.organizer.email) {
		const organizer = new ICAL.Property('organizer');
		organizer.setValue(`mailto:${event.organizer.email}`);
		if (event.organizer.name) organizer.setParameter('cn', event.organizer.name);
		item.addProperty(organizer);
	}
	for (const guest of reply ? [reply] : event.guests) {
		const attendee = new ICAL.Property('attendee');
		attendee.setValue(`mailto:${guest.email}`);
		if (guest.name) attendee.setParameter('cn', guest.name);
		attendee.setParameter('partstat', guest.status);
		if (method === 'REQUEST') attendee.setParameter('rsvp', 'TRUE');
		item.addProperty(attendee);
	}
	if (event.recurrence)
		for (const [key, override] of Object.entries(event.exceptions ?? {})) {
			const times = eventTimes(
				override.startLocal,
				override.endLocal,
				event.timeZone,
				event.allDay
			);
			const detached = new ICAL.Component(
				ICAL.parse(
					invitationFile(
						{ ...event, ...override, ...times, recurrence: null, exceptions: {} },
						method,
						reply
					)
				)
			).getFirstSubcomponent('vevent')!;
			const recurrenceId = new ICAL.Property('recurrence-id');
			recurrenceId.setValue(
				event.allDay
					? ICAL.Time.fromDateString(key)
					: ICAL.Time.fromString(key.length === 16 ? `${key}:00` : key, recurrenceId)
			);
			if (!event.allDay) recurrenceId.setParameter('tzid', event.timeZone);
			detached.addProperty(recurrenceId);
			root.addSubcomponent(detached);
		}
	return root.toString() + '\r\n';
}

export function calendarRoot(source: string, limit = 2 * 1024 * 1024) {
	if (new TextEncoder().encode(source).length > limit)
		throw new Error('Calendar file exceeds the size limit.');
	let depth = 0;
	for (const line of source.split(/\r?\n/)) {
		if (/^BEGIN:/i.test(line) && ++depth > 8)
			throw new Error('Calendar file is nested too deeply.');
		if (/^END:/i.test(line) && --depth < 0) throw new Error('Invalid calendar file.');
	}
	if (depth) throw new Error('Invalid calendar file.');
	const root = new ICAL.Component(ICAL.parse(source));
	if (root.name !== 'vcalendar') throw new Error('Expected an iCalendar file.');
	if (root.getAllSubcomponents('vevent').length > 2000)
		throw new Error('Import at most 2,000 event components.');
	return root;
}
function fileWithEvents(root: ICAL.Component, parts: ICAL.Component[]) {
	const referencedZones = new Set(
		parts.flatMap((part) =>
			part.getAllProperties().map((p) => String(p.getParameter('tzid') ?? ''))
		)
	);
	// Copy only the envelope and selected components, not the entire input for each event.
	return new ICAL.Component(
		JSON.parse(
			JSON.stringify([
				'vcalendar',
				root.getAllProperties().map((p) => p.toJSON()),
				[
					...root
						.getAllSubcomponents('vtimezone')
						.filter((p) => referencedZones.has(String(p.getFirstPropertyValue('tzid'))))
						.map((p) => p.toJSON()),
					...parts.map((p) => p.toJSON())
				]
			])
		)
	).toString();
}
function singleFile(root: ICAL.Component, item: ICAL.Component) {
	return fileWithEvents(root, [item]);
}

/** Accept a bounded complete series; detached updates alone are not applied. */
export function parseInvitation(
	source: string,
	fallbackZone = 'UTC'
): { event: CalendarEvent; method: string } {
	const root = calendarRoot(source, 256 * 1024);
	const parts = root.getAllSubcomponents('vevent');
	const masters = parts.filter((part) => !part.hasProperty('recurrence-id'));
	if (masters.length !== 1 || parts.length > 367)
		throw new Error('Open a calendar file containing one event or one complete recurring series.');
	const master = masters[0];
	const parsed = parseSingleInvitation(singleFile(root, master), fallbackZone);
	const { event } = parsed;
	const occurrences = expandEvent(event, true);
	const lookup = new Map(occurrences.map((o) => [o.occurrenceKey, o]));
	const keyFor = (time: ICAL.Time) =>
		time.isDate
			? time.toString()
			: /Z$/.test(time.toString())
				? localTime(time.toJSDate().toISOString(), event.timeZone)
				: Temporal.PlainDateTime.from(time.toString()).toString({
						smallestUnit: time.second ? 'second' : 'minute'
					});
	for (const property of master.getAllProperties('exdate'))
		for (const value of property.getValues()) {
			const key = keyFor(value as ICAL.Time),
				occurrence = lookup.get(key);
			if (!occurrence) throw new Error('An excluded date does not belong to the supported series.');
			event.exceptions![key] = {
				title: occurrence.title,
				description: occurrence.description,
				location: occurrence.location,
				startLocal: occurrence.startLocal,
				endLocal: occurrence.endLocal,
				cancelled: true
			};
		}
	for (const part of parts.filter((part) => part !== master)) {
		const property = part.getFirstProperty('recurrence-id')!;
		if (property.getParameter('range'))
			throw new Error('RANGE exceptions require conversion to individual exceptions.');
		const key = keyFor(property.getFirstValue() as ICAL.Time);
		if (!lookup.has(key) || event.exceptions![key])
			throw new Error('Duplicate or unknown recurrence exception.');
		const detached = parseSingleInvitation(singleFile(root, part), event.timeZone, true).event;
		if (
			detached.uid !== event.uid ||
			detached.allDay !== event.allDay ||
			detached.organizer.email !== event.organizer.email ||
			detached.sequence !== event.sequence
		)
			throw new Error('The recurrence exception does not match its series.');
		event.exceptions![key] = {
			title: detached.title,
			description: detached.description,
			location: detached.location,
			startLocal: event.allDay ? detached.startLocal : localTime(detached.startsAt, event.timeZone),
			endLocal: event.allDay ? detached.endLocal : localTime(detached.endsAt, event.timeZone),
			cancelled: detached.cancelled
		};
	}
	expandEvent(event);
	return parsed;
}

export function calendarFile(events: CalendarEvent[]) {
	const root = new ICAL.Component('vcalendar');
	root.addPropertyWithValue('version', '2.0');
	root.addPropertyWithValue('prodid', '-//Quickinbox//Calendar//EN');
	for (const event of events) {
		const exported = new ICAL.Component(ICAL.parse(invitationFile(event, 'PUBLISH')));
		for (const part of exported.getAllSubcomponents('vevent')) root.addSubcomponent(part);
	}
	return root.toString() + '\r\n';
}
export function calendarImportSources(source: string) {
	const root = calendarRoot(source);
	const groups = new Map<string, ICAL.Component[]>();
	for (const part of root.getAllSubcomponents('vevent')) {
		const uid = String(part.getFirstPropertyValue('uid') || '');
		const group = groups.get(uid) ?? [];
		group.push(part);
		groups.set(uid, group);
	}
	if (!groups.size || groups.size > 500)
		throw new Error('Choose a file containing 1–500 events or series.');
	let bytes = 0;
	return [...groups.values()].map((parts) => {
		const file = fileWithEvents(root, parts);
		bytes += new TextEncoder().encode(file).length;
		if (bytes > 3 * 1024 * 1024)
			throw new Error(
				'Calendar time-zone data expands beyond the import limit. Split the file into smaller calendars.'
			);
		return file;
	});
}
