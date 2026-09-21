<script lang="ts">
	import { onDestroy } from 'svelte';
	import { organizerRequest } from './client';
	let {
		timeZone,
		calendarId,
		onDone,
		onClose
	}: { timeZone: string; calendarId: string; onDone: () => void; onClose: () => void } = $props();
	let events = $state<{ source: string; title: string; count: number }[]>([]),
		issues = $state<{ row: number; message: string }[]>([]),
		busy = $state(false),
		error = $state(''),
		message = $state('');
	let active = true;
	onDestroy(() => {
		active = false;
	});
	async function preview(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		busy = true;
		error = '';
		message = '';
		events = [];
		issues = [];
		try {
			if (file.size > 2 * 1024 * 1024) throw new Error('Choose a calendar file up to 2 MB.');
			const result = await organizerRequest<{ events: typeof events; issues: typeof issues }>(
				'/api/calendar/transfer',
				'POST',
				{ source: await file.text(), timeZone }
			);
			if (active) {
				events = result.events;
				issues = result.issues;
			}
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function importFile() {
		busy = true;
		error = '';
		let imported = 0,
			skipped = 0;
		try {
			for (let offset = 0; active && offset < events.length; offset += 10) {
				const result = await organizerRequest<{
					imported: number;
					skipped: number;
					issues: typeof issues;
				}>('/api/calendar/transfer', 'POST', {
					sources: events.slice(offset, offset + 10).map((e) => e.source),
					timeZone,
					calendarId: calendarId && calendarId !== 'default' ? calendarId : null
				});
				imported += result.imported;
				skipped += result.skipped;
				issues = [...issues, ...result.issues.map((i) => ({ ...i, row: i.row + offset }))];
				message = `${imported} imported · ${skipped} existing events skipped`;
			}
			if (active) {
				events = [];
				onDone();
			}
		} catch (cause) {
			error = `${(cause as Error).message} Completed batches are saved; retrying skips existing events.`;
			onDone();
		} finally {
			busy = false;
		}
	}
</script>

<section class="transfer" aria-label="Import and export calendar">
	<div class="actions">
		<strong>Move your calendar</strong><button onclick={onClose} disabled={busy}>Close</button>
	</div>
	<p class="subtle">
		Import personal copies into the selected calendar. Guest lists, invitations, and embedded alarms
		are not imported. No email is sent. Unsupported recurrence rules are reported before import.
	</p>
	<div class="actions">
		<label>ICS file<input type="file" accept=".ics" disabled={busy} onchange={preview} /></label><a
			class="button"
			download
			href={`/api/calendar/transfer?calendar=${encodeURIComponent(calendarId)}`}
			>Export calendar .ics</a
		>
	</div>
	{#if events.length}<p>
			{events.length} events or series ({events.reduce((sum, e) => sum + e.count, 0)} occurrences): {events
				.slice(0, 5)
				.map((e) => e.title)
				.join(', ')}{events.length > 5 ? '…' : ''}
		</p>
		<button class="primary" disabled={busy} onclick={importFile}
			>{busy ? 'Importing…' : 'Import personal copies'}</button
		>{/if}
	{#if message}<p role="status">{message}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
	{#if issues.length}<details>
			<summary>{issues.length} events need attention</summary>{#each issues as issue}<p>
					Event {issue.row}: {issue.message}
				</p>{/each}
		</details>{/if}
</section>

<style>
	.transfer {
		margin: 12px 24px;
		padding: 18px;
		border: 1px solid var(--color-line);
		border-radius: 12px;
		display: grid;
		gap: 12px;
		max-height: 45vh;
		overflow: auto;
		flex-shrink: 0;
	}
	strong {
		flex: 1;
	}
	[role='alert'] {
		color: var(--color-danger);
	}
</style>
