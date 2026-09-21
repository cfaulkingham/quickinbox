<script lang="ts">
	import { onMount } from 'svelte';
	import type { CalendarEvent } from './types';
	import { weekBlocks } from './week-layout';
	let {
		days,
		events,
		zone,
		today,
		onOpen,
		onCreate,
		onMove
	}: {
		days: string[];
		events: CalendarEvent[];
		zone: string;
		today: string;
		onOpen: (event: CalendarEvent) => void;
		onCreate: (day: string, hour: number) => void;
		onMove: (event: CalendarEvent, day: string, hour: number) => void;
	} = $props();
	let dragging = $state<CalendarEvent | null>(null),
		moved = $state(false);
	let origin = { x: 0, y: 0 },
		dragEndedAt = 0;
	let hourScroll: HTMLDivElement | undefined;
	const hours = Array.from({ length: 24 }, (_, i) => i);
	onMount(() => {
		if (hourScroll) hourScroll.scrollTop = 8 * 48;
	});
	function pointerStart(e: PointerEvent, event: CalendarEvent) {
		if (!event.owned || e.button !== 0) return;
		dragging = event;
		moved = false;
		origin = { x: e.clientX, y: e.clientY };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function pointerMove(e: PointerEvent) {
		if (dragging && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 8) {
			moved = true;
			e.preventDefault();
		}
	}
	function pointerEnd(e: PointerEvent) {
		if (dragging && moved) {
			dragEndedAt = Date.now();
			const slot = document
				.elementsFromPoint(e.clientX, e.clientY)
				.find(
					(element) => element instanceof HTMLElement && element.dataset.day && element.dataset.hour
				) as HTMLElement | undefined;
			if (slot?.dataset.day) onMove(dragging, slot.dataset.day, Number(slot.dataset.hour));
		}
		dragging = null;
		moved = false;
	}
</script>

<div class="week-scroll">
	<div class="week-header">
		<span class="zone">{zone.split('/').at(-1)?.replaceAll('_', ' ')}</span
		>{#each days as day}<button class:today={day === today} onclick={() => onCreate(day, 9)}
				>{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
					weekday: 'short',
					day: 'numeric'
				})}</button
			>{/each}
	</div>
	<div class="all-day">
		<span>All day</span>{#each days as day}<div>
				{#each events.filter((e) => e.allDay && e.startLocal <= day && e.endLocal > day) as event}<button
						style:border-left-color={event.color}
						onclick={() => onOpen(event)}>{event.title}</button
					>{/each}
			</div>{/each}
	</div>
	<div class="hour-scroll" bind:this={hourScroll}>
		<div class="week-hours">
			<div class="hour-labels">
				{#each hours as hour}<span>{String(hour).padStart(2, '0')}:00</span>{/each}
			</div>
			{#each days as day}<div class="hour-column" class:today={day === today}>
					{#each hours as hour}<button
							class="slot"
							data-day={day}
							data-hour={hour}
							aria-label={`Create event on ${day} at ${hour}:00`}
							onclick={() => onCreate(day, hour)}
						></button>{/each}
					{#each weekBlocks(events, day, zone) as block}<button
							class="appointment"
							class:declined={block.event.response === 'DECLINED'}
							style:top={`${block.top * 0.8}px`}
							style:height={`${block.height * 0.8}px`}
							style:left={`calc(${(block.lane / block.lanes) * 100}% + 2px)`}
							style:width={`calc(${100 / block.lanes}% - 4px)`}
							style:border-left-color={block.event.color}
							class:dragging={moved &&
								dragging?.id === block.event.id &&
								dragging?.occurrenceKey === block.event.occurrenceKey}
							onpointerdown={(e) => pointerStart(e, block.event)}
							onpointermove={pointerMove}
							onpointerup={pointerEnd}
							onpointercancel={() => {
								dragging = null;
								moved = false;
							}}
							onclick={() => {
								if (Date.now() - dragEndedAt < 300) return;
								onOpen(block.event);
							}}
							title={`${block.event.title} · ${new Date(block.event.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone })}`}
							><strong>{block.event.title}</strong><small
								>{new Date(block.event.startsAt).toLocaleTimeString(undefined, {
									hour: 'numeric',
									minute: '2-digit',
									timeZone: zone
								})}{block.event.recurrence ? ' ↻' : ''}</small
							></button
						>{/each}
				</div>{/each}
		</div>
	</div>
</div>

<style>
	.week-scroll {
		min-width: 720px;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 320px;
	}
	.hour-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.appointment {
		touch-action: none;
	}
	.appointment.dragging {
		opacity: 0.6;
		outline: 2px solid var(--color-accent);
		pointer-events: none;
	}
	.week-header,
	.all-day,
	.week-hours {
		display: grid;
		grid-template-columns: 60px repeat(7, minmax(0, 1fr));
	}
	.week-header {
		position: sticky;
		top: 0;
		z-index: 3;
		background: var(--color-surface);
		border-block: 1px solid var(--color-line);
	}
	.week-header button {
		border: 0;
		border-radius: 0;
		padding: 12px 4px;
	}
	.week-header .today {
		color: var(--color-accent-text);
		background: var(--color-accent-soft);
		font-weight: 700;
	}
	.zone {
		font-size: 9px;
		overflow-wrap: anywhere;
		padding: 6px;
		color: var(--color-text-secondary);
	}
	.all-day {
		border-bottom: 1px solid var(--color-line);
		min-height: 44px;
	}
	.all-day > span {
		padding: 10px 4px;
		font-size: 10px;
		color: var(--color-text-secondary);
	}
	.all-day > div {
		border-left: 1px solid var(--color-line);
		padding: 3px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.all-day button {
		text-align: left;
		font-size: 10px;
		padding: 4px;
		border-left: 3px solid;
		overflow-wrap: anywhere;
	}
	.hour-column {
		position: relative;
		height: 1152px;
		border-left: 1px solid var(--color-line);
	}
	.hour-column.today {
		background: color-mix(in srgb, var(--color-accent-soft) 35%, transparent);
	}
	.hour-labels span {
		display: block;
		height: 48px;
		font-size: 10px;
		text-align: right;
		padding: 3px 8px 0 0;
		color: var(--color-text-secondary);
	}
	.hour-column .slot {
		display: block;
		width: 100%;
		height: 48px;
		border: 0;
		border-bottom: 1px solid var(--color-line);
		border-radius: 0;
		background: transparent;
	}
	.hour-column .slot:hover {
		background: var(--color-surface-hover);
	}
	.hour-column .appointment {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
		overflow: hidden;
		padding: 3px 4px;
		font-size: 11px;
		border: 1px solid var(--color-line);
		border-left: 3px solid;
		border-radius: 4px;
		background: var(--color-accent-soft);
		z-index: 1;
	}
	.appointment strong {
		overflow-wrap: anywhere;
		font-weight: 500;
	}
	.appointment small {
		font-size: 9px;
	}
	.appointment.declined {
		opacity: 0.5;
		text-decoration: line-through;
	}
</style>
