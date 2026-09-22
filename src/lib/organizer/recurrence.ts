import { Temporal } from '@js-temporal/polyfill';
import type { CalendarEvent, Recurrence } from './types';
import { eventTimes } from './dates';

export const MAX_OCCURRENCES = 366;
/** Finite, wall-clock recurrence. Invalid month dates and DST gaps do not count. */
export function expandEvent(event: CalendarEvent, includeCancelled = false): CalendarEvent[] {
	if (!event.recurrence) return event.cancelled && !includeCancelled ? [] : [event];
	const rule = event.recurrence;
	validateRecurrence(rule);
	const base = Temporal.PlainDateTime.from(
		event.allDay ? `${event.startLocal}T00:00` : event.startLocal
	);
	const last = Temporal.PlainDateTime.from(
		event.allDay ? `${event.endLocal}T00:00` : event.endLocal
	);
	const duration = base.until(last, { largestUnit: 'days' });
	const results: CalendarEvent[] = [];
	let generated = 0;
	const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
	const byDay = rule.byDay ?? [];
	if (byDay.length && !byDay.includes(weekdays[base.dayOfWeek - 1]))
		throw new Error('The start date must match a selected BYDAY repeat weekday.');
	const weekStart = weekdays.indexOf(rule.weekStart ?? 'MO') + 1;
	const weekAnchor = base.toPlainDate().subtract({ days: (base.dayOfWeek - weekStart + 7) % 7 });
	const until = rule.until ? normalizedUntil(rule.until) : null;
	if (until?.instant !== null && until?.instant !== undefined) {
		until.date = Temporal.Instant.fromEpochMilliseconds(until.instant)
			.toZonedDateTimeISO(event.timeZone)
			.toPlainDate()
			.toString();
	}

	for (
		let index = 0;
		generated < (rule.count ?? MAX_OCCURRENCES + 1) &&
		index < (byDay.length ? 48000 : MAX_OCCURRENCES * 24);
		index++
	) {
		let start: Temporal.PlainDateTime;
		try {
			const amount = index * rule.interval;
			if (byDay.length) {
				start = base.add({ days: index });
				if (until && start.toPlainDate().toString() > until.date) break;
				const weeks = Math.floor(
					weekAnchor.until(start.toPlainDate(), { largestUnit: 'days' }).days / 7
				);
				if (
					!byDay.includes(weekdays[start.dayOfWeek - 1]) ||
					(rule.frequency === 'WEEKLY' ? weeks % rule.interval : index % rule.interval)
				)
					continue;
			} else
				start = base.add(
					rule.frequency === 'DAILY'
						? { days: amount }
						: rule.frequency === 'WEEKLY'
							? { weeks: amount }
							: rule.frequency === 'MONTHLY'
								? { months: amount }
								: { years: amount },
					{ overflow: 'reject' }
				);
		} catch {
			continue;
		}
		if (until && start.toPlainDate().toString() > until.date) break;
		const end = start.add(duration);
		if (end.year > 2100) throw new Error('The recurring series must end by 2100.');
		const firstZoned = start.toZonedDateTime(event.timeZone, { disambiguation: 'compatible' });
		if (until?.instant && firstZoned.epochMilliseconds > until.instant) break;
		const lastZoned = end.toZonedDateTime(event.timeZone, { disambiguation: 'compatible' });
		if (
			!event.allDay &&
			(!firstZoned.toPlainDateTime().equals(start) || !lastZoned.toPlainDateTime().equals(end))
		)
			continue;
		const local = (time: Temporal.PlainDateTime) =>
			event.allDay
				? time.toPlainDate().toString()
				: time.toString({ smallestUnit: time.second ? 'second' : 'minute' });
		const key = local(start),
			override = event.exceptions?.[key];
		const occurrence = {
			...event,
			startLocal: key,
			endLocal: local(end),
			startsAt: firstZoned.toInstant().toString({ smallestUnit: 'millisecond' }),
			endsAt: lastZoned.toInstant().toString({ smallestUnit: 'millisecond' }),
			occurrenceKey: key,
			...override
		};
		if (override)
			Object.assign(
				occurrence,
				eventTimes(override.startLocal, override.endLocal, event.timeZone, event.allDay)
			);
		generated++;
		if (generated > MAX_OCCURRENCES)
			throw new Error('This series exceeds 366 occurrences. Choose an earlier end date.');
		if (includeCancelled || (!event.cancelled && !occurrence.cancelled)) results.push(occurrence);
	}
	if (!generated || (rule.count !== undefined && generated !== rule.count))
		throw new Error('This recurrence cannot be expanded within supported limits.');
	return results;
}

function normalizedUntil(value: string) {
	const compact = value.replaceAll('-', '').replaceAll(':', '');
	if (!/^\d{8}(T\d{6}Z)?$/.test(compact))
		throw new Error('Choose a valid recurrence end date or UTC end time.');
	const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
	Temporal.PlainDate.from(date, { overflow: 'reject' });
	const instant =
		compact.length > 8
			? Temporal.Instant.from(
					`${date}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`
				).epochMilliseconds
			: null;
	return { date, instant, compact };
}
export function validateRecurrence(rule: Recurrence) {
	if (
		!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.frequency) ||
		!Number.isInteger(rule.interval) ||
		rule.interval < 1 ||
		rule.interval > 30
	)
		throw new Error('Repeat at intervals of 1–30.');
	if ((rule.count !== undefined) === !!rule.until)
		throw new Error(
			'Choose either COUNT (occurrences) or UNTIL (end date). Unbounded recurrence is not supported.'
		);
	if (
		rule.count !== undefined &&
		(!Number.isInteger(rule.count) || rule.count < 1 || rule.count > MAX_OCCURRENCES)
	)
		throw new Error('Repeat between 1 and 366 times.');
	if (rule.until) normalizedUntil(rule.until);
	const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
	if (rule.weekStart && !days.includes(rule.weekStart)) throw new Error('Invalid week start.');
	if (
		rule.byDay &&
		(!['DAILY', 'WEEKLY'].includes(rule.frequency) ||
			!rule.byDay.length ||
			rule.byDay.length > 7 ||
			new Set(rule.byDay).size !== rule.byDay.length ||
			rule.byDay.some((d) => !days.includes(d)))
	)
		throw new Error('Weekday selection is supported for daily and weekly series.');
}
export function recurrenceRule(rule: Recurrence) {
	validateRecurrence(rule);
	return `FREQ=${rule.frequency};INTERVAL=${rule.interval};${rule.until ? `UNTIL=${normalizedUntil(rule.until).compact}` : `COUNT=${rule.count}`}${rule.byDay?.length ? `;BYDAY=${rule.byDay.join(',')}` : ''}${rule.weekStart ? `;WKST=${rule.weekStart}` : ''}`;
}
export function parseRecurrence(value: string): Recurrence {
	const entries = value
		.toUpperCase()
		.split(';')
		.map((p) => p.split('='));
	const parts = Object.fromEntries(entries);
	if (
		entries.some((e) => e.length !== 2) ||
		Object.keys(parts).length !== entries.length ||
		Object.keys(parts).some(
			(k) => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST'].includes(k)
		) ||
		(parts.COUNT !== undefined && !/^\d+$/.test(parts.COUNT)) ||
		(parts.INTERVAL !== undefined && !/^\d+$/.test(parts.INTERVAL))
	)
		throw new Error('Unsupported recurrence rule. Use COUNT or UNTIL and daily/weekly BYDAY.');
	const rule: Recurrence = {
		frequency: parts.FREQ as Recurrence['frequency'],
		interval: Number(parts.INTERVAL || 1),
		...(parts.COUNT ? { count: Number(parts.COUNT) } : {}),
		...(parts.UNTIL ? { until: parts.UNTIL } : {}),
		...(parts.BYDAY ? { byDay: parts.BYDAY.split(',') } : {}),
		...(parts.WKST ? { weekStart: parts.WKST } : {})
	};
	validateRecurrence(rule);
	return rule;
}

export function eventReminders(event: CalendarEvent) {
	return event.reminders ?? (event.reminderMinutes === null ? [] : [event.reminderMinutes]);
}
