import { Temporal } from '@js-temporal/polyfill';
import type { CalendarEvent, Recurrence } from './types';
import { eventTimes } from './dates';

export const MAX_OCCURRENCES = 366;
/** Finite, wall-clock recurrence. Invalid month dates and DST gaps do not count. */
export function expandEvent(event: CalendarEvent, includeCancelled = false): CalendarEvent[] {
	if (!event.recurrence) return event.cancelled && !includeCancelled ? [] : [event];
	const rule = event.recurrence;
	if (
		!Number.isInteger(rule.count) ||
		rule.count < 1 ||
		rule.count > MAX_OCCURRENCES ||
		!Number.isInteger(rule.interval) ||
		rule.interval < 1 ||
		rule.interval > 30
	)
		throw new Error('Repeat between 1 and 366 times, at intervals of 1–30.');
	const base = Temporal.PlainDateTime.from(
		event.allDay ? `${event.startLocal}T00:00` : event.startLocal
	);
	const last = Temporal.PlainDateTime.from(
		event.allDay ? `${event.endLocal}T00:00` : event.endLocal
	);
	const duration = base.until(last, { largestUnit: 'days' });
	const results: CalendarEvent[] = [];
	let generated = 0;
	for (let index = 0; generated < rule.count && index < MAX_OCCURRENCES * 24; index++) {
		let start: Temporal.PlainDateTime;
		try {
			const amount = index * rule.interval;
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
		const end = start.add(duration);
		if (end.year > 2100) throw new Error('The recurring series must end by 2100.');
		const firstZoned = start.toZonedDateTime(event.timeZone, { disambiguation: 'compatible' });
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
		if (includeCancelled || (!event.cancelled && !occurrence.cancelled)) results.push(occurrence);
	}
	if (generated !== rule.count)
		throw new Error('This recurrence cannot be expanded within supported limits.');
	return results;
}

export function recurrenceRule(rule: Recurrence) {
	return `FREQ=${rule.frequency};INTERVAL=${rule.interval};COUNT=${rule.count}`;
}
export function parseRecurrence(value: string): Recurrence {
	const parts = Object.fromEntries(
		value
			.toUpperCase()
			.split(';')
			.map((part) => part.split('='))
	);
	if (
		Object.keys(parts).some((key) => !['FREQ', 'INTERVAL', 'COUNT', 'WKST'].includes(key)) ||
		!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ) ||
		!/^\d+$/.test(parts.COUNT || '') ||
		(parts.INTERVAL !== undefined && !/^\d+$/.test(parts.INTERVAL))
	)
		throw new Error(
			'Supported recurring files use daily, weekly, monthly, or yearly rules with COUNT (up to 366). BYDAY, UNTIL, and unbounded rules need conversion first.'
		);
	const rule = {
		frequency: parts.FREQ as Recurrence['frequency'],
		interval: Number(parts.INTERVAL || 1),
		count: Number(parts.COUNT)
	};
	if (rule.count < 1 || rule.count > MAX_OCCURRENCES || rule.interval < 1 || rule.interval > 30)
		throw new Error('Recurrence exceeds supported limits (366 occurrences, interval 1–30).');
	return rule;
}

export function eventReminders(event: CalendarEvent) {
	return event.reminders ?? (event.reminderMinutes === null ? [] : [event.reminderMinutes]);
}
