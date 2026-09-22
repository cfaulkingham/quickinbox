import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testStore } from './testing/store';
import { insertEmail } from './mail-store';
import {
	saveTask,
	getTask,
	listTasks,
	dismissTaskReminder,
	taskReminders,
	sendTaskReminders
} from './tasks';
import { vacationRecipient, saveVacation, processVacation } from './vacation';
import { searchAttachments } from './attachment-browser';
import { insertAttachments } from './attachments';
import {
	saveCalendarEvent,
	cancelCalendarEvent,
	listCalendarEvents,
	getCalendarEvent
} from './calendar';
import { saveOrganizerSettings } from './organizer-settings';
import { visibleCalendarEvent } from './calendar-access';
import { setCalendarShare, changeCalendarFeed, readCalendarFeed } from './calendar-sharing';
import { expandEvent, parseRecurrence } from '$lib/organizer/recurrence';
import { invitationFile, parseInvitation, calendarFile } from './calendar-ical';
import {
	addSubscription,
	refreshSubscriptions,
	removeSubscription,
	subscriptionUrl,
	fetchCalendarSource
} from './calendar-subscriptions';
const input = {
	title: 'Planning',
	startLocal: '2030-03-05T09:00',
	endLocal: '2030-03-05T10:00',
	timeZone: 'America/Chicago',
	fromAddressId: 'address-1',
	guests: [],
	reminders: []
};
const count = (s: ReturnType<typeof testStore>, table: string) =>
	(s.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const sent = (s: ReturnType<typeof testStore>) =>
	insertEmail(s.db, {
		userId: s.user.id,
		direction: 'outbound',
		from: s.user.email,
		to: 'friend@example.org',
		subject: 'Proposal',
		status: 'sent',
		addressId: s.from.id,
		domainId: s.from.domain_id,
		messageId: 'proposal-1'
	});
const taskInput = (id: string) => ({
	kind: 'followup',
	title: 'Check proposal',
	sourceEmailId: id,
	dueAt: '2030-03-08T15:00:00.000Z',
	reminderAt: '2030-03-08T15:00:00.000Z'
});

test('follow-ups resolve on a reply in the same account/thread, not unrelated inbound mail', async () => {
	const s = testStore(),
		id = await sent(s),
		task = await saveTask(s.db, s.user.id, taskInput(id));
	await insertEmail(s.db, {
		userId: s.user.id,
		direction: 'inbound',
		from: 'else@example.org',
		to: s.user.email,
		subject: 'Different topic'
	});
	assert.equal((await getTask(s.db, s.user.id, task.id))!.completed_at, null);
	await insertEmail(s.db, {
		userId: s.user.id,
		direction: 'inbound',
		from: 'friend@example.org',
		to: s.user.email,
		subject: 'Re: Proposal',
		inReplyTo: 'proposal-1',
		domainId: s.from.domain_id
	});
	assert.equal((await getTask(s.db, s.user.id, task.id))!.completion_reason, 'replied');
	assert.equal((await listTasks(s.db, s.user.id, 'followup')).tasks.length, 0);
	assert.equal((await listTasks(s.db, 'user-2')).tasks.length, 0);
	await assert.rejects(saveTask(s.db, 'user-2', taskInput(id)), { status: 404 });
});
test('follow-up creation catches replies already received and rejects duplicate pending reminders', async () => {
	const s = testStore(),
		id = await sent(s);
	await saveTask(s.db, s.user.id, taskInput(id));
	await assert.rejects(saveTask(s.db, s.user.id, taskInput(id)), { status: 409 });
	await insertEmail(s.db, {
		userId: s.user.id,
		direction: 'inbound',
		from: 'friend@example.org',
		to: s.user.email,
		subject: 'Re: Proposal',
		inReplyTo: 'proposal-1',
		domainId: s.from.domain_id
	});
	const task = await saveTask(s.db, s.user.id, taskInput(id));
	assert.equal(task.completion_reason, 'replied');
});
test('task updates reject stale writers; reminder dismissal, snooze and completion are durable', async () => {
	const s = testStore();
	const raw = {
		title: 'Review proposal',
		dueAt: '2030-01-01T00:00:00.000Z',
		reminderAt: '2020-01-01T00:00:00.000Z'
	};
	let task = await saveTask(s.db, s.user.id, raw);
	assert.equal((await taskReminders(s.db, s.user.id)).length, 1);
	await sendTaskReminders(s.env);
	assert.ok((await getTask(s.db, s.user.id, task.id))!.notified_at);
	await dismissTaskReminder(s.db, s.user.id, task.id, task.version, true);
	assert.equal((await taskReminders(s.db, s.user.id)).length, 0);
	await assert.rejects(saveTask(s.db, s.user.id, { ...raw, version: task.version }, task.id), {
		status: 409
	});
	task = (await getTask(s.db, s.user.id, task.id))!;
	task = await saveTask(s.db, s.user.id, { ...raw, version: task.version }, task.id);
	await dismissTaskReminder(s.db, s.user.id, task.id, task.version);
	assert.equal((await taskReminders(s.db, s.user.id)).length, 0);
	task = (await getTask(s.db, s.user.id, task.id))!;
	await saveTask(s.db, s.user.id, { ...raw, version: task.version, completed: true }, task.id);
	assert.equal((await listTasks(s.db, s.user.id, 'task', true)).tasks.length, 1);
});
test('vacation eligibility excludes loops, mailing lists, bounces, catch-all and mismatched envelopes', () => {
	const h = { 'Return-Path': '<friend@example.org>' };
	assert.equal(vacationRecipient(h, 'friend@example.org', true), 'friend@example.org');
	const blockedHeaders: Record<string, string>[] = [
		{ 'Auto-Submitted': 'auto-replied' },
		{ 'List-Id': 'list' },
		{ Precedence: 'bulk' },
		{ 'X-Auto-Response-Suppress': 'OOF' },
		{ 'Return-Path': '<>' },
		{ 'Return-Path': '<other@example.org>' }
	];
	for (const blocked of blockedHeaders)
		assert.equal(vacationRecipient({ ...h, ...blocked }, 'friend@example.org', true), null);
	assert.equal(vacationRecipient(h, 'friend@example.org', false), null);
	assert.equal(vacationRecipient(undefined, 'friend@example.org', true), null);
});
const vacation = {
	addressId: 'address-1',
	enabled: true,
	startsAt: '2026-01-01T00:00:00.000Z',
	endsAt: '2026-12-31T00:00:00.000Z',
	subject: 'Away',
	body: 'Back soon',
	repeatDays: 7,
	version: 0
};
async function vacationFixture() {
	const s = testStore();
	await saveVacation(s.db, s.user.id, vacation);
	// Simulate mail arriving after activation but before the worker's one-minute processing delay.
	s.sqlite.exec("UPDATE vacation_settings SET updated_at=datetime('now','-10 minutes')");
	for (let i = 0; i < 2; i++) {
		const id = await insertEmail(s.db, {
			userId: s.user.id,
			direction: 'inbound',
			from: 'friend@example.org',
			to: s.user.email,
			subject: `Hello ${i}`,
			addressId: s.from.id,
			domainId: s.from.domain_id,
			vacationRecipient: 'friend@example.org'
		});
		s.sqlite.query("UPDATE emails SET created_at=datetime('now','-2 minutes') WHERE id=?").run(id);
	}
	return s;
}
test('vacation replies throttle atomically and reuse their durable Outbox reservation after a retry', async () => {
	const s = await vacationFixture();
	await Promise.all([processVacation(s.env, 'resend'), processVacation(s.env, 'resend')]);
	assert.equal(count(s, 'vacation_replies'), 1);
	assert.equal(count(s, 'outbox_jobs'), 1);
	const payload = JSON.parse(
		(s.sqlite.query('SELECT payload_json FROM vacation_replies').get() as { payload_json: string })
			.payload_json
	);
	assert.equal(payload.outbound.headers['Auto-Submitted'], 'auto-replied');
	assert.equal(payload.outbound.headers['X-Auto-Response-Suppress'], 'All');
	s.sqlite.exec("UPDATE vacation_replies SET state='pending',lease_until=0");
	await processVacation(s.env, 'resend');
	assert.equal(count(s, 'outbox_jobs'), 1);
});
test('vacation settings are address scoped, versioned, and inactive responses are not queued', async () => {
	const s = testStore();
	await assert.rejects(saveVacation(s.db, 'user-2', vacation), { status: 404 });
	await saveVacation(s.db, s.user.id, vacation);
	await assert.rejects(saveVacation(s.db, s.user.id, vacation), { status: 409 });
	await saveVacation(s.db, s.user.id, { ...vacation, enabled: false, version: 1 });
	await processVacation(s.env, 'resend');
	assert.equal(count(s, 'vacation_replies'), 0);
});
test('attachment search is account scoped and hides drafts/spam/trash while matching filenames', async () => {
	const s = testStore(),
		id = await sent(s);
	await insertAttachments(s.db, s.bucket, id, [
		{ filename: 'Proposal.PDF', type: 'application/pdf', content: btoa('%PDF-1.4\n%%EOF') }
	]);
	assert.equal((await searchAttachments(s.db, s.user.id, 'proposal')).files.length, 1);
	assert.equal((await searchAttachments(s.db, 'user-2', 'proposal')).files.length, 0);
	s.sqlite.query("UPDATE emails SET spam_at=datetime('now') WHERE id=?").run(id);
	assert.equal((await searchAttachments(s.db, s.user.id, 'proposal')).files.length, 0);
});
test('weekday/end-date recurrence includes the final day and preserves local time across DST and ICS roundtrip', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		recurrence: { frequency: 'WEEKLY', interval: 1, until: '2030-03-14', byDay: ['TU', 'TH'] }
	});
	const occurrences = expandEvent(event);
	assert.deepEqual(
		occurrences.map((o) => o.startLocal),
		['2030-03-05T09:00', '2030-03-07T09:00', '2030-03-12T09:00', '2030-03-14T09:00']
	);
	assert.equal(occurrences[0].startsAt, '2030-03-05T15:00:00.000Z');
	assert.equal(occurrences[2].startsAt, '2030-03-12T14:00:00.000Z');
	const file = invitationFile(event, 'PUBLISH');
	assert.match(file, /UNTIL=20300315T045959Z/);
	assert.deepEqual(
		expandEvent(parseInvitation(file).event).map((e) => e.startsAt),
		occurrences.map((e) => e.startsAt)
	);
	await assert.rejects(
		saveCalendarEvent(s.db, s.user, {
			...input,
			recurrence: { frequency: 'DAILY', interval: 1, until: '2035-01-01' }
		}),
		{ status: 400 }
	);
	assert.throws(() => parseRecurrence('FREQ=MONTHLY;COUNT=4;BYDAY=1MO'), /Weekday/);
	assert.throws(() => parseRecurrence('FREQ=WEEKLY;COUNT=4;UNTIL=20300501'), /COUNT/);
});
test('recurrence respects non-Monday week starts at multi-week intervals', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		startLocal: '2030-03-03T09:00',
		endLocal: '2030-03-03T10:00',
		recurrence: { frequency: 'WEEKLY', interval: 2, count: 4, byDay: ['SU', 'TU'], weekStart: 'SU' }
	});
	assert.deepEqual(
		expandEvent(event).map((o) => o.startLocal.slice(0, 10)),
		['2030-03-03', '2030-03-05', '2030-03-17', '2030-03-19']
	);
});
async function sharedFixture() {
	const s = testStore();
	const calendar = (
		await saveOrganizerSettings(s.db, s.user.id, { calendar: { name: 'Team', color: '#112233' } })
	).calendars[0];
	const source = await sent(s);
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		calendarId: calendar.id,
		sourceEmailId: source
	});
	return { ...s, calendar, event };
}
test('shared calendars enforce read/write permissions and strip links to private source messages', async () => {
	const s = await sharedFixture();
	assert.equal(await visibleCalendarEvent(s.db, 'user-2', s.event.id), null);
	await setCalendarShare(s.db, s.user.id, s.calendar.id, {
		email: 'other@example.test',
		permission: 'read'
	});
	const visible = (await visibleCalendarEvent(s.db, 'user-2', s.event.id))!;
	assert.equal(visible.sourceEmailId, null);
	assert.equal(visible.fromAddressId, null);
	assert.equal(visible.access, 'read');
	const other = { ...s.user, id: 'user-2', email: 'other@example.test' };
	await assert.rejects(
		saveCalendarEvent(s.db, other, { ...input, calendarId: s.calendar.id, version: 1 }, s.event.id),
		{ status: 403 }
	);
	const events = await listCalendarEvents(s.db, 'user-2', '2030-03-01', '2030-04-01');
	assert.equal(events.events.length, 1);
	assert.equal(events.events[0].sourceEmailId, null);
	await setCalendarShare(s.db, s.user.id, s.calendar.id, {
		email: other.email,
		permission: 'write'
	});
	const saved = await saveCalendarEvent(
		s.db,
		other,
		{ ...input, title: 'Edited by teammate', calendarId: s.calendar.id, version: 1 },
		s.event.id
	);
	assert.equal(saved.version, 2);
	assert.equal(saved.sourceEmailId, null);
	assert.equal(
		(await getCalendarEvent(s.db, s.user.id, s.event.id))!.sourceEmailId,
		s.event.sourceEmailId
	);
	await setCalendarShare(s.db, s.user.id, s.calendar.id, {
		email: other.email,
		permission: 'remove'
	});
	assert.equal(await visibleCalendarEvent(s.db, 'user-2', s.event.id), null);
	await assert.rejects(cancelCalendarEvent(s.db, other, s.event.id, 2), { status: 404 });
});
test('revoked calendar permissions fail the atomic event update even after initial access checks', async () => {
	const s = await sharedFixture();
	await setCalendarShare(s.db, s.user.id, s.calendar.id, {
		email: 'other@example.test',
		permission: 'write'
	});
	let revoked = false;
	s.faults.sql = (sql) => {
		if (!revoked && sql.startsWith('UPDATE calendar_events SET title')) {
			revoked = true;
			s.sqlite.exec('DELETE FROM calendar_shares');
		}
	};
	await assert.rejects(
		saveCalendarEvent(
			s.db,
			{ ...s.user, id: 'user-2' },
			{ ...input, calendarId: s.calendar.id, version: 1 },
			s.event.id
		),
		{ status: 409 }
	);
	assert.equal((await getCalendarEvent(s.db, s.user.id, s.event.id))!.version, 1);
});
test('calendar subscription links are scoped, hashed, rotated, and revocable', async () => {
	const s = await sharedFixture();
	await assert.rejects(changeCalendarFeed(s.db, 'user-2', s.calendar.id, true), { status: 404 });
	const { token } = await changeCalendarFeed(s.db, s.user.id, s.calendar.id, true);
	assert.match(await readCalendarFeed(s.db, token!), /SUMMARY:Planning/);
	const hash = (
		s.sqlite.query('SELECT token_hash FROM calendar_feeds').get() as { token_hash: string }
	).token_hash;
	assert.notEqual(hash, token);
	await changeCalendarFeed(s.db, s.user.id, s.calendar.id, true);
	await assert.rejects(readCalendarFeed(s.db, token!), { status: 404 });
	const next = await changeCalendarFeed(s.db, s.user.id, s.calendar.id, true);
	await changeCalendarFeed(s.db, s.user.id, s.calendar.id, false);
	await assert.rejects(readCalendarFeed(s.db, next.token!), { status: 404 });
});
test('external subscription URLs reject local destinations and validate redirect targets', async () => {
	for (const url of [
		'http://example.org/feed',
		'https://127.0.0.1/feed',
		'https://[::1]/feed',
		'https://server.local/feed',
		'https://user:password@example.org/feed',
		'https://example.org:444/feed'
	])
		assert.throws(() => subscriptionUrl(url));
	assert.equal(
		subscriptionUrl('webcal://example.org/calendar.ics'),
		'https://example.org/calendar.ics'
	);
	const fetcher = async () =>
		new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
	await assert.rejects(fetchCalendarSource('https://example.org/calendar.ics', fetcher), {
		status: 400
	});
});
test('external calendar refresh replaces an atomic snapshot, retains old events on bad feeds and cannot send invites', async () => {
	const s = testStore(),
		event = await saveCalendarEvent(s.db, s.user, input);
	const id = await addSubscription(s.db, s.user.id, {
		name: 'External',
		url: 'https://example.org/calendar.ics'
	});
	let source = calendarFile([event]);
	const fetcher = async () => new Response(source);
	await refreshSubscriptions(s.db, id, fetcher);
	const row = () =>
		s.sqlite
			.query("SELECT data_json FROM calendar_events WHERE json_extract(data_json,'$.calendarId')=?")
			.get(id) as { data_json: string } | null;
	assert.equal(JSON.parse(row()!.data_json).subscription, true);
	assert.equal(count(s, 'calendar_notices'), 0);
	source = 'invalid calendar';
	await refreshSubscriptions(s.db, id, fetcher);
	assert.ok(row());
	source = calendarFile([{ ...event, title: 'Updated feed' }]);
	await refreshSubscriptions(s.db, id, fetcher);
	assert.equal(JSON.parse(row()!.data_json).title, 'Updated feed');
	source = calendarFile([]);
	await refreshSubscriptions(s.db, id, fetcher);
	assert.equal(row(), null);
	await removeSubscription(s.db, s.user.id, id);
	assert.equal(count(s, 'calendar_subscriptions'), 0);
});

test('imported historical replies do not resolve a live follow-up', async () => {
	const s = testStore(),
		id = await sent(s),
		task = await saveTask(s.db, s.user.id, taskInput(id));
	s.sqlite
		.query(
			"INSERT INTO emails(id,user_id,direction,from_addr,to_addr,subject,thread_id,created_at) VALUES('imported-reply',?,'inbound','friend@example.org',?,'Re: Proposal',?,'2020-01-01')"
		)
		.run(s.user.id, s.user.email, task.thread_id);
	assert.equal((await getTask(s.db, s.user.id, task.id))!.completed_at, null);
});
test('UTC UNTIL includes local dates ahead of UTC and invalid subscription changes cannot queue mail', async () => {
	const s = testStore();
	const event = await saveCalendarEvent(s.db, s.user, {
		...input,
		timeZone: 'Pacific/Auckland',
		recurrence: { frequency: 'DAILY', interval: 1, until: '20300306T235959Z' }
	});
	assert.deepEqual(
		expandEvent(event).map((o) => o.startLocal.slice(0, 10)),
		['2030-03-05', '2030-03-06', '2030-03-07']
	);
	const subscription = await addSubscription(s.db, s.user.id, {
		name: 'Outside',
		url: 'https://example.org/test.ics'
	});
	await assert.rejects(saveCalendarEvent(s.db, s.user, { ...input, calendarId: subscription }), {
		status: 403
	});
});
test('new events cannot be inserted into a shared calendar after write access is revoked', async () => {
	const s = await sharedFixture();
	s.sqlite.exec(
		"INSERT INTO addresses(id,user_id,domain_id,address,is_default) VALUES('address-2','user-2','domain-1','other@example.test',1)"
	);
	await setCalendarShare(s.db, s.user.id, s.calendar.id, {
		email: 'other@example.test',
		permission: 'write'
	});
	let revoked = false;
	s.faults.sql = (sql) => {
		if (!revoked && sql.startsWith('INSERT INTO calendar_events')) {
			revoked = true;
			s.sqlite.exec('DELETE FROM calendar_shares');
		}
	};
	await assert.rejects(
		saveCalendarEvent(
			s.db,
			{ ...s.user, id: 'user-2', email: 'other@example.test' },
			{ ...input, fromAddressId: 'address-2', calendarId: s.calendar.id }
		),
		{ status: 409 }
	);
	assert.equal(count(s, 'calendar_events'), 1);
});
