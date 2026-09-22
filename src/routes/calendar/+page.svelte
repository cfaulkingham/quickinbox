<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Temporal } from '@js-temporal/polyfill';
	import type { PageData } from './$types';
	import type { CalendarEvent, PersonalCalendar } from '$lib/organizer/types';
	import { eventTimes, localTime, shiftDate } from '$lib/organizer/dates';
	import { organizerRequest } from '$lib/organizer/client';
	import { validTimeZone } from '$lib/organizer/dates';
	import WeekGrid from '$lib/organizer/WeekGrid.svelte';
	import CalendarSubscriptions from '$lib/organizer/CalendarSubscriptions.svelte';
	import CalendarSharing from '$lib/organizer/CalendarSharing.svelte';
	import CalendarTransfer from '$lib/organizer/CalendarTransfer.svelte';
	import EventEditor from '$lib/organizer/EventEditor.svelte';
	import '$lib/organizer/organizer.css';
	let { data }: { data: PageData } = $props();
	let zone = $state('UTC'),
		date = $state(new Date().toISOString().slice(0, 10)),
		today = $state(untrack(() => date));
	let series = $state<CalendarEvent | null>(untrack(() => data.series));
	let calendars = $state<PersonalCalendar[]>(untrack(() => data.settings.calendars));
	let calendarId = $state(''),
		search = $state(''),
		appliedSearch = $state(''),
		transferring = $state(false),
		settingsOpen = $state(false);
	let zoneInput = $state(''),
		calendarName = $state(''),
		calendarColor = $state('#729681'),
		initialHour = $state(9);
	let zones = $state<string[]>(['UTC']);
	async function saveZone() {
		try {
			if (!validTimeZone(zoneInput)) throw new Error('Choose a valid IANA time zone.');
			await organizerRequest('/api/calendar/settings', 'POST', { timeZone: zoneInput });
			zone = zoneInput;
			today = localTime(new Date().toISOString(), zone, true);
			notice = 'Calendar time zone saved.';
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
	async function addCalendar() {
		try {
			const result = await organizerRequest<{ calendars: PersonalCalendar[] }>(
				'/api/calendar/settings',
				'POST',
				{ calendar: { name: calendarName, color: calendarColor } }
			);
			calendars = result.calendars;
			calendarName = '';
			notice = 'Calendar added.';
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
	let view = $state<'month' | 'week' | 'agenda'>('month');
	let events = $state<CalendarEvent[]>([]),
		selected = $state<CalendarEvent | null>(untrack(() => data.selected));
	let editing = $state(
		Boolean(untrack(() => data.selected || data.seed.sourceEmailId || data.seed.guests))
	);
	let editorDate = $state(untrack(() => date)),
		editorKey = $state(0),
		useSeed = $state(true);
	let loading = $state(true),
		error = $state(''),
		notice = $state(''),
		ready = $state(false),
		run = 0;
	let owner = untrack(() => data.user?.id);
	let seededRoute = untrack(() =>
		JSON.stringify([
			data.user?.id,
			data.selected?.id,
			data.selected?.occurrenceKey,
			data.seed.sourceEmailId,
			data.seed.guests
		])
	);
	$effect(() => {
		const current = data.user?.id;
		if (current !== owner)
			untrack(() => {
				owner = current;
				series = data.series;
				calendars = data.settings.calendars;
				calendarId = '';
				search = '';
				appliedSearch = '';
				settingsOpen = false;
				transferring = false;
				zone = data.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
				zoneInput = zone;
				today = localTime(new Date().toISOString(), zone, true);
				date = today;
				run++;
				events = [];
				selected = data.selected;
				series = data.series;
				editing = Boolean(data.selected || data.seed.sourceEmailId || data.seed.guests);
				useSeed = true;
				error = '';
				notice = '';
				editorKey++;
			});
	});
	onMount(() => {
		zone = data.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		zoneInput = zone;
		zones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
		today = localTime(new Date().toISOString(), zone, true);
		date = data.selected ? localTime(data.selected.startsAt, zone, true) : today;
		editorDate = date;
		if (window.matchMedia('(max-width:700px)').matches) view = 'agenda';
		ready = true;
	});
	$effect(() => {
		const route = JSON.stringify([
			data.user?.id,
			data.selected?.id,
			data.selected?.occurrenceKey,
			data.seed.sourceEmailId,
			data.seed.guests
		]);
		if (ready && route !== seededRoute) {
			seededRoute = route;
			untrack(() => {
				selected = data.selected;
				series = data.series;
				if (selected) date = localTime(selected.startsAt, zone, true);
				editing = Boolean(selected || data.seed.sourceEmailId || data.seed.guests);
				useSeed = true;
				editorKey++;
			});
		}
	});
	const first = $derived.by(() => {
		const day = Temporal.PlainDate.from(date);
		if (view === 'week') return day.subtract({ days: day.dayOfWeek % 7 }).toString();
		const month = day.with({ day: 1 });
		return view === 'agenda'
			? month.toString()
			: month.subtract({ days: month.dayOfWeek % 7 }).toString();
	});
	const days = $derived(
		Array.from(
			{
				length:
					view === 'week' ? 7 : view === 'agenda' ? Temporal.PlainDate.from(date).daysInMonth : 42
			},
			(_, i) => shiftDate(first, i)
		)
	);
	const title = $derived(
		new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
			new Date(`${date}T12:00:00Z`)
		)
	);
	$effect(() => {
		void data.user?.id;
		if (ready) {
			const a = first,
				b = shiftDate(days.at(-1)!, 1),
				tz = zone,
				q = appliedSearch,
				calendar = calendarId;
			void load(a, b, tz, q, calendar);
		}
	});
	async function load(
		a = first,
		b = shiftDate(days.at(-1)!, 1),
		tz = zone,
		q = appliedSearch,
		calendar = calendarId
	) {
		const current = ++run;
		loading = true;
		error = '';
		try {
			const range = eventTimes(a, b, tz, true);
			const result = await organizerRequest<{ events: CalendarEvent[]; truncated: boolean }>(
				`/api/calendar?start=${encodeURIComponent(range.startsAt)}&end=${encodeURIComponent(range.endsAt)}&q=${encodeURIComponent(q)}&calendar=${encodeURIComponent(calendar)}`
			);
			if (current !== run) return;
			events = result.events;
			if (result.truncated)
				notice = 'This view reached its event limit. Choose a smaller date range or one calendar.';
		} catch (cause) {
			if (current === run) error = (cause as Error).message;
		} finally {
			if (current === run) loading = false;
		}
	}
	function move(delta: number) {
		const day = Temporal.PlainDate.from(date);
		date =
			view === 'week'
				? day.add({ days: delta * 7 }).toString()
				: day.with({ day: 1 }).add({ months: delta }).toString();
	}
	function dayEvents(day: string) {
		return events.filter((e) =>
			e.allDay
				? e.startLocal <= day && e.endLocal > day
				: localTime(e.startsAt, zone, true) <= day &&
					localTime(new Date(Date.parse(e.endsAt) - 1).toISOString(), zone, true) >= day
		);
	}
	function time(event: CalendarEvent) {
		return event.allDay
			? 'All day'
			: new Intl.DateTimeFormat(undefined, {
					hour: 'numeric',
					minute: '2-digit',
					timeZone: zone
				}).format(new Date(event.startsAt));
	}
	function create(day = today, hour = 9) {
		series = null;
		initialHour = hour;
		selected = null;
		editing = true;
		editorDate = day;
		useSeed = false;
		editorKey++;
	}
	async function open(event: CalendarEvent, moveTo?: { day: string; hour: number }) {
		const openingOwner = owner;
		try {
			const result = await organizerRequest<{ event: CalendarEvent; series: CalendarEvent }>(
				`/api/calendar/${event.id}?occurrence=${encodeURIComponent(event.occurrenceKey || '')}`
			);
			if (owner !== openingOwner) return;
			series = result.series;
			selected = result.event;
			if (moveTo && !selected.allDay) {
				const duration = Date.parse(selected.endsAt) - Date.parse(selected.startsAt);
				const start = Temporal.PlainDateTime.from(
					`${moveTo.day}T${String(moveTo.hour).padStart(2, '0')}:00`
				).toZonedDateTime(zone, { disambiguation: 'reject' }).epochMilliseconds;
				selected = {
					...selected,
					startLocal: localTime(new Date(start).toISOString(), selected.timeZone),
					endLocal: localTime(new Date(start + duration).toISOString(), selected.timeZone)
				};
				notice = 'Review the new time and save to reschedule.';
			}
			editing = true;
			useSeed = false;
			editorKey++;
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
	function saved(event: CalendarEvent) {
		selected = event;
		series = event;
		editing = false;
		editorKey++;
		notice = event.cancelled
			? 'Event cancelled. Guest cancellations are queued in Outbox.'
			: event.owned && event.guests.length
				? 'Event saved. Invitations are queued in Outbox.'
				: 'Calendar updated.';
		void load();
	}
</script>

<svelte:head><title>Calendar — Quickinbox</title></svelte:head>
<div class="organizer calendar-page">
	<header class="organizer-header">
		<div>
			<h1>Calendar</h1>
			<p class="subtle">Plan your day, invite people, and stay on time.</p>
		</div>
		<div class="actions">
			<button onclick={() => (settingsOpen = !settingsOpen)}>Calendar settings</button><button
				onclick={() => (transferring = !transferring)}>Import / Export</button
			><button onclick={() => load()} disabled={loading}>Refresh</button><button
				class="primary"
				onclick={() => create()}>+ New event</button
			>
		</div>
	</header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if notice}<p
			class="notice"
			role="status"
		>
			{notice}
		</p>{/if}
	{#if settingsOpen}<section class="settings-panel" aria-label="Calendar settings">
			<form
				class="actions"
				onsubmit={(e) => {
					e.preventDefault();
					void saveZone();
				}}
			>
				<label
					>Display time zone<input bind:value={zoneInput} list="calendar-zones" required /><datalist
						id="calendar-zones"
						>{#each zones as tz}<option value={tz}></option>{/each}</datalist
					></label
				><button>Save time zone</button>
			</form>
			<form
				class="actions"
				onsubmit={(e) => {
					e.preventDefault();
					void addCalendar();
				}}
			>
				<label
					>New calendar<input
						bind:value={calendarName}
						maxlength="80"
						required
						placeholder="Work, Family…"
					/></label
				><label>Color<input type="color" bind:value={calendarColor} /></label><button
					>Add calendar</button
				>
			</form>
			<CalendarSharing {calendars} />
			<CalendarSubscriptions onChange={() => {void organizerRequest<{calendars:PersonalCalendar[]}>('/api/calendar/settings').then(r => {calendars=r.calendars;void load();}).catch(c => error=c.message);}} />
		</section>{/if}
	{#if transferring}<CalendarTransfer
			timeZone={zone}
			{calendarId}
			onDone={() => load()}
			onClose={() => (transferring = false)}
		/>{/if}
	<div class="calendar-body" class:editing>
		<section class="calendar-main" aria-label="Calendar">
			<div class="calendar-toolbar">
				<div class="actions">
					<button onclick={() => (date = today)}>Today</button><button
						aria-label="Previous period"
						onclick={() => move(-1)}>‹</button
					><button aria-label="Next period" onclick={() => move(1)}>›</button>
					<h2>{title}</h2>
				</div>
				<div class="actions">
					<select aria-label="Calendar view" bind:value={view}
						><option value="month">Month</option><option value="week">Week</option><option
							value="agenda">Agenda</option
						></select
					><input
						type="date"
						aria-label="Go to date"
						value={date}
						onchange={(e) => {
							if (e.currentTarget.value) date = e.currentTarget.value;
						}}
						required
					/>
				</div>
			</div>
			<form
				class="calendar-search actions"
				onsubmit={(e) => {
					e.preventDefault();
					appliedSearch = search;
				}}
			>
				<input
					type="search"
					aria-label="Search calendar"
					bind:value={search}
					placeholder="Search this period"
				/><button>Search</button>{#if appliedSearch}<button
						type="button"
						onclick={() => {
							search = '';
							appliedSearch = '';
						}}>Clear</button
					>{/if}<select aria-label="Choose calendar" bind:value={calendarId}
					><option value="">All calendars</option><option value="default">Personal</option
					>{#each calendars as calendar}<option value={calendar.id}>{calendar.name}</option
						>{/each}</select
				>
			</form>
			<p class="calendar-zone subtle">
				{zone}{loading ? ' · Loading…' : ''}{appliedSearch ? ` · ${events.length} matches` : ''}
			</p>
			{#if view === 'week'}<WeekGrid
					{days}
					{events}
					{zone}
					{today}
					onOpen={(event) => open(event)}
					onCreate={create}
					onMove={(event, day, hour) => open(event, { day, hour })}
				/>
			{:else if view === 'agenda'}
				<div class="agenda">
					{#each days as day}{@const appointments = dayEvents(day)}{#if appointments.length}<section
							>
								<h3>
									{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
										weekday: 'short',
										month: 'short',
										day: 'numeric'
									})}
								</h3>
								{#each appointments as event}<button
										class="agenda-event"
										onclick={() => open(event)}
										><span class="event-dot" style:background={event.color}></span><span
											>{time(event)}</span
										><strong>{event.title}</strong><span class="subtle">{event.location}</span
										></button
									>{/each}
							</section>{/if}{/each}
					{#if !loading && !events.length}<div class="empty">
							<h2>Your month is open</h2>
							<p class="subtle">Create an event or accept an invitation from your inbox.</p>
							<button onclick={() => create()}>Create an event</button>
						</div>{/if}
				</div>
			{:else}
				<div class="calendar-grid">
					<div class="weekdays">
						{#each ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as day}<span>{day}</span
							>{/each}
					</div>
					<div class="day-grid">
						{#each days as day}<section
								class="day"
								class:outside={day.slice(0, 7) !== date.slice(0, 7)}
								class:today={day === today}
								aria-label={day}
							>
								<button
									class="day-number"
									aria-label={`New event on ${day}`}
									onclick={() => create(day)}>{Number(day.slice(-2))}</button
								>
								<div class="day-events">
									{#each dayEvents(day) as event}<button
											class="event"
											class:declined={event.response === 'DECLINED'}
											onclick={() => open(event)}
											title={`${time(event)} · ${event.title}`}
											style:border-left-color={event.color}
											><span class="event-time">{time(event)}</span><span>{event.title}</span
											></button
										>{/each}
								</div>
							</section>{/each}
					</div>
				</div>
			{/if}
		</section>
		{#if editing && ready}{#key `${editorKey}-${data.user?.id}`}<EventEditor
					event={selected}
					{series}
					{calendars}
					{initialHour}
					initialCalendarId={calendarId === 'default' ? '' : calendarId}
					addresses={data.addresses}
					date={editorDate}
					timeZone={zone}
					seed={useSeed ? data.seed : undefined}
					{events}
					onSave={saved}
					onClose={() => (editing = false)}
				/>{/key}{/if}
	</div>
</div>

<style>
	.settings-panel {
		max-height: 65vh;
		overflow: auto;
		flex-shrink: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 24px;
		padding: 16px 24px;
		border-bottom: 1px solid var(--color-line);
	}
	.settings-panel form {
		align-items: end;
	}
	.calendar-search {
		padding: 0 24px 12px;
	}
	.calendar-search input {
		max-width: min(240px, 100%);
	}
	.calendar-search select {
		width: auto;
		max-width: 200px;
	}
	.calendar-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.calendar-body.editing {
		grid-template-columns: minmax(350px, 1fr) minmax(360px, 440px);
	}
	.calendar-main {
		min-width: 0;
		overflow: auto;
		display: flex;
		flex-direction: column;
	}
	.calendar-toolbar {
		padding: 18px 24px 8px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.calendar-toolbar h2 {
		margin-left: 8px;
		font-size: 18px;
	}
	.calendar-toolbar select {
		width: auto;
	}
	.calendar-toolbar input {
		max-width: 148px;
	}
	.calendar-zone {
		padding: 0 24px 16px;
	}
	.calendar-grid {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 590px;
		min-width: 600px;
	}
	.weekdays,
	.day-grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
	}
	.weekdays {
		border-top: 1px solid var(--color-line);
	}
	.weekdays span {
		text-align: center;
		color: var(--color-text-secondary);
		font-size: 11px;
		padding: 10px 0;
	}
	.day-grid {
		flex: 1;
		grid-template-rows: repeat(6, minmax(86px, 1fr));
	}
	.day {
		min-width: 0;
		border-top: 1px solid var(--color-line);
		border-right: 1px solid var(--color-line);
		padding: 4px;
	}
	.day.outside {
		background: var(--color-surface-muted);
	}
	.day .day-number {
		padding: 4px;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 50%;
		display: block;
		margin: 0 auto 3px;
		font-size: 11px;
		background: transparent;
	}
	.day.today .day-number {
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-weight: 700;
	}
	.day-events {
		display: grid;
		gap: 3px;
	}
	.day .event {
		min-width: 0;
		width: 100%;
		border: 0;
		border-left: 3px solid;
		border-radius: 4px;
		padding: 4px;
		display: flex;
		gap: 4px;
		text-align: left;
		font-size: 11px;
		background: var(--color-accent-soft);
	}
	.event span {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.event .event-time {
		flex: none;
		max-width: 65px;
		font-size: 10px;
		opacity: 0.75;
	}
	.event.declined {
		opacity: 0.5;
		text-decoration: line-through;
	}
	.agenda {
		padding: 0 24px 24px;
	}
	.agenda section {
		border-top: 1px solid var(--color-line);
		padding: 18px 0;
	}
	.agenda h3 {
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 10px;
	}
	.agenda .agenda-event {
		width: 100%;
		display: flex;
		align-items: center;
		text-align: left;
		gap: 14px;
		border: 0;
		padding: 12px 8px;
	}
	.event-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}
	@media (max-width: 1150px) {
		.calendar-body.editing {
			grid-template-columns: 1fr;
			overflow: auto;
		}
		.editing .calendar-main {
			display: none;
		}
	}
	@media (max-width: 700px) {
		.calendar-toolbar {
			padding: 16px 12px 8px;
		}
		.calendar-zone {
			padding-left: 12px;
		}
		.calendar-grid {
			min-width: 490px;
		}
		.event-time {
			display: none;
		}
	}
</style>
