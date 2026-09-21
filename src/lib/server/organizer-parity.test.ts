import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testStore } from './testing/store';
import { contactGroups, getContact, listContacts, mergeContacts, saveContact } from './contacts';
import { csvRows, exportContacts, importContacts, previewContacts } from './contact-transfer';
import {
	actOnReminder,
	cancelCalendarEvent,
	getCalendarEvent,
	listCalendarEvents,
	persistCalendarEvent,
	respondFromCalendar,
	saveCalendarEvent
} from './calendar';
import { calendarFile, invitationFile, parseInvitation } from './calendar-ical';
import { importCalendar, previewCalendar, exportCalendar } from './calendar-transfer';
import { organizerSettings, saveOrganizerSettings } from './organizer-settings';
import { expandEvent } from '$lib/organizer/recurrence';
import { weekBlocks } from '$lib/organizer/week-layout';
import type { CalendarEvent } from '$lib/organizer/types';
const input = {
	title: 'Team meeting',
	description: 'Planning',
	location: 'Office',
	startLocal: '2030-03-03T09:00',
	endLocal: '2030-03-03T10:00',
	timeZone: 'America/Chicago',
	fromAddressId: 'address-1',
	guests: []
};
const weekly = { frequency: 'WEEKLY' as const, interval: 1, count: 4 };
const countRows = (s: ReturnType<typeof testStore>, table: string) =>
	(s.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test('large calendar reads are bounded and occurrence lists do not duplicate series exceptions', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		description: '漢'.repeat(8000),
		recurrence: { frequency: 'DAILY', interval: 1, count: 366 },
		reminders: []
	});
	const result = await listCalendarEvents(s.db, s.user.id, '2030-03-01', '2031-03-05');
	assert.equal(result.truncated, true);
	assert.ok(result.events.length > 0 && result.events.length < 366);
	assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 4 * 1024 * 1024 + 100);
	assert.equal(result.events[0].exceptions, undefined);
	const exceptions = Object.fromEntries(
		expandEvent(event)
			.slice(0, 20)
			.map((o) => [
				o.occurrenceKey!,
				{
					title: o.title,
					description: o.description,
					location: o.location,
					cancelled: false,
					startLocal: o.startLocal,
					endLocal: o.endLocal
				}
			])
	);
	await persistCalendarEvent(s.db, s.user.id, { ...event, exceptions, version: 2 }, event);
	for (let index = 0; index < 9; index++) {
		await persistCalendarEvent(
			s.db,
			s.user.id,
			{
				...event,
				exceptions,
				id: crypto.randomUUID(),
				uid: `large-series-${index}`,
				recurrence: { frequency: 'DAILY', interval: 1, count: 20 }
			},
			null
		);
	}
	await assert.rejects(exportCalendar(s.db, s.user.id), { status: 400 });
	const smallRange = await listCalendarEvents(s.db, s.user.id, '2030-03-03', '2030-03-04');
	assert.equal(smallRange.truncated, true);
	assert.ok(smallRange.events.length < 10);
});

test('contact groups, birthdays, phone search and address-less contacts are private', async () => {
	const s = testStore();
	const contact = await saveContact(s.db, s.user.id, {
		name: 'Mum',
		emails: [],
		phone: '5550102',
		birthday: '1960-02-29',
		groups: ['Family', 'Family'],
		starred: true
	});
	assert.deepEqual(contact.groups, ['Family']);
	assert.equal((await listContacts(s.db, s.user.id, '0102', 100, 0, 'Family', true)).total, 1);
	assert.equal((await listContacts(s.db, s.user.id, '', 100, 0, 'Work')).total, 0);
	assert.deepEqual(await contactGroups(s.db, 'user-2'), []);
	await assert.rejects(
		saveContact(s.db, s.user.id, { ...contact, birthday: '2025-02-29' }, contact.id),
		{ status: 400 }
	);
});

test('merge retains information and emails atomically, rejecting stale, foreign and concurrent sources', async () => {
	const s = testStore();
	const a = await saveContact(s.db, s.user.id, {
		name: 'Alex',
		emails: ['a@example.test'],
		phone: '111',
		groups: ['Work']
	});
	const b = await saveContact(s.db, s.user.id, {
		name: 'Alex duplicate',
		emails: ['b@example.test'],
		phone: '222',
		birthday: '1990-01-01',
		groups: ['Friends'],
		notes: 'Keep me',
		starred: true
	});
	await assert.rejects(mergeContacts(s.db, 'user-2', [a, b]), { status: 409 });
	s.faults.sql = (sql) => {
		if (sql.startsWith('INSERT INTO contact_emails')) throw new Error('disk full');
	};
	await assert.rejects(mergeContacts(s.db, s.user.id, [a, b]), /disk full/);
	s.faults.sql = undefined;
	assert.deepEqual(await getContact(s.db, s.user.id, b.id), b);
	const outcomes = await Promise.allSettled([
		mergeContacts(s.db, s.user.id, [a, b]),
		mergeContacts(s.db, s.user.id, [a, b])
	]);
	assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
	const merged = (await getContact(s.db, s.user.id, a.id))!;
	assert.deepEqual(merged.emails, ['a@example.test', 'b@example.test']);
	assert.deepEqual(merged.groups, ['Work', 'Friends']);
	assert.equal(merged.birthday, b.birthday);
	assert.equal(merged.starred, true);
	assert.match(merged.notes, /222/);
	assert.match(merged.notes, /Keep me/);
	assert.equal(await getContact(s.db, s.user.id, b.id), null);
	await assert.rejects(mergeContacts(s.db, s.user.id, [a, b]), { status: 409 });
});

test('CSV/vCard previews preserve quoted multiline values, folds and groups; imports are retry-safe', async () => {
	const s = testStore();
	const original = await saveContact(s.db, s.user.id, {
		name: 'Zoë, "Example"',
		emails: ['zoe@example.test', 'work@example.test'],
		notes: 'Line 1\nLine 2; \\backslash',
		groups: ['Friends', 'Work'],
		birthday: '1992-02-29'
	});
	for (const format of ['csv', 'vcf'] as const) {
		const text = exportContacts([original], format);
		const preview = previewContacts(text, format);
		assert.deepEqual(preview.issues, []);
		assert.equal(preview.contacts.length, 1);
		assert.equal(preview.contacts[0].name, original.name);
		assert.equal(preview.contacts[0].notes, original.notes);
		assert.deepEqual(preview.contacts[0].groups, original.groups);
		const first = await importContacts(s.db, 'user-2', preview.contacts);
		assert.equal(first.imported + first.skipped, 1);
		const retry = await importContacts(s.db, 'user-2', preview.contacts);
		assert.equal(retry.skipped, 1);
	}
	assert.deepEqual(csvRows('Name,Notes\r\n"Alex","line\nwith ""quotes"""'), [
		['Name', 'Notes'],
		['Alex', 'line\nwith "quotes"']
	]);
	assert.throws(() => previewContacts('Name,Email\n"unclosed', 'csv'));
	assert.equal(
		previewContacts('Name,Email\nAlex,invalid\nGood,good@example.test', 'csv').issues.length,
		1
	);
	assert.equal(
		previewContacts('BEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:Old\nEND:VCARD', 'vcf')
			.issues.length,
		1
	);
	assert.throws(() => previewContacts('x'.repeat(2 * 1024 * 1024 + 1), 'vcf'), { status: 413 });
	assert.match(exportContacts([{ ...original, name: '=DANGEROUS()' }], 'csv'), /'=DANGEROUS/);
});

test('bounded wall-clock series span DST, skip invalid month dates and DST gaps', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		recurrence: weekly,
		reminders: [10, 60]
	});
	const occurrences = expandEvent(event);
	assert.deepEqual(
		occurrences.map((o) => o.startsAt.slice(11, 16)),
		['15:00', '14:00', '14:00', '14:00']
	);
	assert.equal(countRows(s, 'calendar_reminders'), 8);
	const month = await saveCalendarEvent(s.db, s.user, {
		...input,
		startLocal: '2030-01-31T09:00',
		endLocal: '2030-01-31T10:00',
		recurrence: { frequency: 'MONTHLY', interval: 1, count: 3 }
	});
	assert.deepEqual(
		expandEvent(month).map((o) => o.startLocal.slice(0, 10)),
		['2030-01-31', '2030-03-31', '2030-05-31']
	);
	const gap = await saveCalendarEvent(s.db, s.user, {
		...input,
		startLocal: '2030-03-09T02:30',
		endLocal: '2030-03-09T03:30',
		recurrence: { frequency: 'DAILY', interval: 1, count: 3 }
	});
	assert.deepEqual(
		expandEvent(gap).map((o) => o.startLocal.slice(0, 10)),
		['2030-03-09', '2030-03-11', '2030-03-12']
	);
	await assert.rejects(
		saveCalendarEvent(s.db, s.user, { ...input, recurrence: { ...weekly, count: 367 } }),
		{ status: 400 }
	);
	await assert.rejects(
		saveCalendarEvent(s.db, s.user, {
			...input,
			recurrence: { frequency: 'YEARLY', interval: 30, count: 10 }
		}),
		{ status: 400 }
	);
});

test('occurrence edits, future edits, cancellation and range searches preserve the series and reject stale versions', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, { ...input, recurrence: weekly });
	const occurrence = expandEvent(event)[1];
	const edited = await saveCalendarEvent(
		s.db,
		s.user,
		{
			...occurrence,
			scope: 'this',
			title: 'Moved',
			startLocal: '2030-02-01T09:00',
			endLocal: '2030-02-01T10:00'
		},
		event.id
	);
	assert.equal(expandEvent(edited)[0].title, event.title);
	assert.equal(expandEvent(edited)[1].title, 'Moved');
	assert.equal(
		(await listCalendarEvents(s.db, s.user.id, '2030-02-01', '2030-02-02', 'moved')).events.length,
		1
	);
	assert.equal(
		(await listCalendarEvents(s.db, 'user-2', '2030-02-01', '2030-02-02')).events.length,
		0
	);
	await assert.rejects(
		saveCalendarEvent(s.db, s.user, { ...occurrence, scope: 'this' }, event.id),
		{ status: 409 }
	);
	const future = expandEvent(edited)[2];
	const shifted = await saveCalendarEvent(
		s.db,
		s.user,
		{
			...future,
			scope: 'future',
			startLocal: '2030-03-17T11:00',
			endLocal: '2030-03-17T12:00',
			title: 'Later'
		},
		event.id
	);
	assert.deepEqual(
		expandEvent(shifted).map((o) => o.startLocal.slice(11)),
		['09:00', '09:00', '11:00', '11:00']
	);
	const cancelled = await cancelCalendarEvent(
		s.db,
		s.user,
		event.id,
		shifted.version,
		'future',
		future.occurrenceKey
	);
	assert.equal(expandEvent(cancelled).length, 2);
	assert.equal(countRows(s, 'calendar_reminders'), 2);
	await cancelCalendarEvent(s.db, s.user, event.id, cancelled.version);
	assert.equal(countRows(s, 'calendar_reminders'), 0);
});

test('recurring ICS preserves timezone, moved/cancelled exceptions and rejects detached or unbounded updates', async () => {
	const s = testStore();
	let event = await saveCalendarEvent(s.db, s.user, { ...input, recurrence: weekly });
	let occurrence = expandEvent(event)[1];
	event = await saveCalendarEvent(
		s.db,
		s.user,
		{ ...occurrence, scope: 'this', startLocal: '2030-03-11T09:00', endLocal: '2030-03-11T10:00' },
		event.id
	);
	occurrence = expandEvent(event)[2];
	event = await cancelCalendarEvent(
		s.db,
		s.user,
		event.id,
		event.version,
		'this',
		occurrence.occurrenceKey
	);
	const file = invitationFile(event, 'REQUEST');
	const parsed = parseInvitation(file).event;
	assert.equal(parsed.timeZone, event.timeZone);
	assert.deepEqual(parsed.recurrence, event.recurrence);
	assert.deepEqual(
		expandEvent(parsed).map((o) => [o.startsAt, o.endsAt, o.title]),
		expandEvent(event).map((o) => [o.startsAt, o.endsAt, o.title])
	);
	assert.throws(() => parseInvitation(file.replace(';COUNT=4', '')), /COUNT/);
	assert.throws(
		() => parseInvitation(file.replace('RRULE:FREQ=WEEKLY', 'RRULE:FREQ=WEEKLY;BYDAY=MO')),
		/BYDAY/
	);
	assert.throws(
		() =>
			parseInvitation(
				file.replace(
					'RECURRENCE-ID;TZID=America/Chicago:20300310T090000',
					'RECURRENCE-ID;TZID=America/Chicago:20300309T090000'
				)
			),
		/exception/
	);
});

test('calendar copies import without notices, ignore alarms, skip retries and isolate accounts/calendars', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		recurrence: weekly,
		guests: [{ email: 'guest@example.test' }]
	});
	const file = calendarFile([event]);
	const preview = previewCalendar(file, 'UTC');
	assert.equal(preview.events.length, 1);
	assert.equal(preview.issues.length, 0);
	const calendar = (
		await saveOrganizerSettings(s.db, s.user.id, {
			timeZone: 'America/Chicago',
			calendar: { name: 'Work', color: '#123456' }
		})
	).calendars[0];
	assert.equal((await organizerSettings(s.db, 'user-2')).calendars.length, 0);
	await assert.rejects(
		saveCalendarEvent(s.db, { ...s.user, id: 'user-2' }, { ...input, calendarId: calendar.id }),
		{ status: 404 }
	);
	const initialNotices = countRows(s, 'calendar_notices');
	const changedUID = preview.events[0].source.replaceAll(event.uid, 'imported-uid');
	const result = await importCalendar(s.db, s.user, {
		sources: [changedUID],
		timeZone: 'UTC',
		calendarId: calendar.id
	});
	assert.equal(result.imported, 1);
	assert.equal(countRows(s, 'calendar_notices'), initialNotices);
	assert.equal(
		(await importCalendar(s.db, s.user, { sources: [changedUID], timeZone: 'UTC' })).skipped,
		1
	);
	assert.equal(
		(await listCalendarEvents(s.db, s.user.id, '2030-03-01', '2030-04-01', '', calendar.id)).events
			.length,
		4
	);
	assert.equal(
		(await listCalendarEvents(s.db, s.user.id, '2030-03-01', '2030-04-01', '', 'default')).events
			.length,
		4
	);
	assert.equal(
		previewCalendar(await exportCalendar(s.db, s.user.id, calendar.id), 'UTC').events.length,
		1
	);
});

test('multiple reminders retain dismissals/snoozes on unrelated edits and invalidate moved occurrences', async () => {
	const s = testStore();
	const start = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16);
	const end = new Date(Date.now() + 90 * 60_000).toISOString().slice(0, 16);
	let event = await saveCalendarEvent(s.db, s.user, {
		...input,
		startLocal: start,
		endLocal: end,
		timeZone: 'UTC',
		reminders: [60, 120]
	});
	const reminders = s.sqlite.query('SELECT id FROM calendar_reminders ORDER BY minutes').all() as {
		id: string;
	}[];
	await actOnReminder(s.db, s.user.id, { id: reminders[0].id, snoozeMinutes: 10 });
	await actOnReminder(s.db, s.user.id, { id: reminders[1].id });
	await assert.rejects(actOnReminder(s.db, 'user-2', { id: reminders[0].id, snoozeMinutes: 10 }), {
		status: 409
	});
	event = await saveCalendarEvent(s.db, s.user, { ...event, title: 'New title' }, event.id);
	assert.equal(countRows(s, 'calendar_reminders'), 2);
	assert.equal(
		(
			s.sqlite
				.query('SELECT COUNT(*) AS n FROM calendar_reminders WHERE dismissed_at IS NOT NULL')
				.get() as { n: number }
		).n,
		1
	);
	assert.equal(
		(
			s.sqlite
				.query('SELECT COUNT(*) AS n FROM calendar_reminders WHERE title = ?')
				.get('New title') as { n: number }
		).n,
		2
	);
	event = await saveCalendarEvent(s.db, s.user, { ...event, reminders: [] }, event.id);
	assert.equal(countRows(s, 'calendar_reminders'), 0);
});

test('calendar details RSVP validates attendee/version and queues one reply, preserving reminder choices', async () => {
	const s = testStore();
	const template = await saveCalendarEvent(s.db, s.user, input);
	const invitation: CalendarEvent = {
		...template,
		id: crypto.randomUUID(),
		uid: 'outside',
		owned: false,
		organizer: { email: 'host@example.test', name: 'Host' },
		guests: [{ email: s.user.email, name: 'Me', status: 'NEEDS-ACTION' }],
		response: 'NEEDS-ACTION',
		reminders: [],
		reminderMinutes: null
	};
	await persistCalendarEvent(s.db, s.user.id, invitation, null);
	const accepted = await respondFromCalendar(s.db, s.user, invitation.id, {
		version: 1,
		response: 'ACCEPTED'
	});
	assert.equal(accepted.response, 'ACCEPTED');
	assert.equal(countRows(s, 'calendar_notices'), 1);
	assert.equal(
		(
			await respondFromCalendar(s.db, s.user, invitation.id, {
				version: accepted.version,
				response: 'ACCEPTED'
			})
		).version,
		accepted.version
	);
	await assert.rejects(
		respondFromCalendar(s.db, s.user, invitation.id, { version: 1, response: 'DECLINED' }),
		{ status: 409 }
	);
	await assert.rejects(
		respondFromCalendar(s.db, { ...s.user, id: 'user-2' }, invitation.id, {
			version: 2,
			response: 'DECLINED'
		}),
		{ status: 404 }
	);
});

test('week layout splits overlaps and clips overnight appointments', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, input);
	const overlapping = { ...event, id: 'other' };
	assert.deepEqual(
		weekBlocks([event, overlapping], '2030-03-03', 'America/Chicago').map((b) => [b.lane, b.lanes]),
		[
			[0, 2],
			[1, 2]
		]
	);
	assert.equal(weekBlocks([event], '2030-03-04', 'America/Chicago').length, 0);
	const overnight = {
		...event,
		startsAt: '2030-03-03T05:30:00.000Z',
		endsAt: '2030-03-03T07:00:00.000Z'
	};
	assert.equal(weekBlocks([overnight], '2030-03-03', 'America/Chicago')[0].top, 0);
});

test('changing a series schedule requires explicit consent before removing occurrence edits', async () => {
	const s = testStore();
	const original = await saveCalendarEvent(s.db, s.user, { ...input, recurrence: weekly });
	const occurrence = expandEvent(original)[1];
	const edited = await saveCalendarEvent(
		s.db,
		s.user,
		{ ...occurrence, scope: 'this', title: 'Exception' },
		original.id
	);
	await assert.rejects(
		saveCalendarEvent(
			s.db,
			s.user,
			{ ...edited, recurrence: { ...weekly, count: 5 } },
			original.id
		),
		{ status: 400 }
	);
	assert.equal(
		expandEvent((await getCalendarEvent(s.db, s.user.id, original.id))!)[1].title,
		'Exception'
	);
	const reset = await saveCalendarEvent(
		s.db,
		s.user,
		{ ...edited, recurrence: { ...weekly, count: 5 }, resetExceptions: true },
		original.id
	);
	assert.equal(expandEvent(reset).length, 5);
	assert.deepEqual(reset.exceptions, {});
});

test('failed occurrence edits roll back event, notices and reminders together', async () => {
	const s = testStore();
	const original = await saveCalendarEvent(s.db, s.user, {
		...input,
		recurrence: weekly,
		guests: [{ email: 'guest@example.test' }]
	});
	const occurrence = expandEvent(original)[1];
	s.faults.sql = (sql) => {
		if (sql.startsWith('INSERT INTO calendar_reminders'))
			throw new Error('reminder storage failed');
	};
	await assert.rejects(
		saveCalendarEvent(
			s.db,
			s.user,
			{ ...occurrence, scope: 'future', title: 'Uncommitted' },
			original.id
		),
		/storage failed/
	);
	s.faults.sql = undefined;
	assert.deepEqual(await getCalendarEvent(s.db, s.user.id, original.id), original);
	assert.equal(countRows(s, 'calendar_notices'), 1);
	assert.equal(countRows(s, 'calendar_reminders'), 4);
});

test('contact transfer preserves international phones and favorites; photos do not prevent import', async () => {
	const s = testStore();
	const contact = await saveContact(s.db, s.user.id, {
		name: 'Phone only',
		emails: [],
		phone: '+33 123456',
		starred: true,
		groups: ['People'],
		notes: 'One'
	});
	for (const format of ['csv', 'vcf'] as const) {
		const file = exportContacts([contact], format);
		const parsed = previewContacts(
			format === 'vcf' ? file.replace('END:VCARD', 'PHOTO;ENCODING=b:AAAA\r\nEND:VCARD') : file,
			format
		);
		assert.equal(parsed.contacts[0].phone, contact.phone);
		assert.equal(parsed.contacts[0].starred, true);
	}
	const imported = await importContacts(s.db, s.user.id, [
		{ ...contact, notes: 'Different person' }
	]);
	assert.equal(imported.imported, 1);
});

test('migration preserves existing reminder delivery and dismissal state', async () => {
	const { Database } = await import('bun:sqlite');
	const { readFileSync, readdirSync } = await import('node:fs');
	const sqlite = new Database(':memory:');
	const migrations = new URL('../../../migrations/', import.meta.url);
	for (const file of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql') && f < '0030')
		.sort())
		sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
	sqlite.exec(
		"INSERT INTO users(id,email,name,password_hash) VALUES ('u','u@example.test','User','hash')"
	);
	const data = JSON.stringify({ reminderMinutes: 30 });
	sqlite
		.query(
			"INSERT INTO calendar_events(id,user_id,uid,title,starts_at,ends_at,organizer_email,data_json,version,mutation_id,created_at,updated_at) VALUES ('e','u','uid','Meeting','2030-01-01T09:00:00.000Z','2030-01-01T10:00:00.000Z','u@example.test',?,3,'mutation','now','now')"
		)
		.run(data);
	sqlite.exec(
		"INSERT INTO calendar_reminders(id,user_id,event_id,event_version,due_at,title,starts_at,notified_at,dismissed_at) VALUES ('r','u','e',3,'2030-01-01T08:30:00.000Z','Meeting','2030-01-01T09:00:00.000Z','delivered','dismissed')"
	);
	sqlite.exec(readFileSync(new URL('0030_organizer_parity.sql', migrations), 'utf8'));
	assert.deepEqual(
		sqlite
			.query(
				'SELECT minutes, event_version, notified_at, dismissed_at, ends_at FROM calendar_reminders'
			)
			.get(),
		{
			minutes: 30,
			event_version: 3,
			notified_at: 'delivered',
			dismissed_at: 'dismissed',
			ends_at: '2030-01-01T10:00:00.000Z'
		}
	);
	assert.equal(
		(sqlite.query('SELECT range_end FROM calendar_events').get() as { range_end: string })
			.range_end,
		'2030-01-01T10:00:00.000Z'
	);
	sqlite.close();
});

test('recurring ICS retains seconds and rejects invalid scoped dates as validation errors', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		startLocal: '2030-03-03T09:00:30',
		endLocal: '2030-03-03T10:00:30',
		recurrence: weekly
	});
	const parsed = parseInvitation(invitationFile(event, 'PUBLISH')).event;
	assert.deepEqual(
		expandEvent(parsed).map((o) => [o.startsAt, o.occurrenceKey]),
		expandEvent(event).map((o) => [o.startsAt, o.occurrenceKey])
	);
	await assert.rejects(
		saveCalendarEvent(
			s.db,
			s.user,
			{ ...expandEvent(event)[1], scope: 'this', startLocal: 'invalid' },
			event.id
		),
		{ status: 400 }
	);
});
