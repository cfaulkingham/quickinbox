<script lang="ts">
	import { onMount } from 'svelte';
	import { organizerRequest } from './client';
	let { onChange }: { onChange: () => void } = $props();
	let name = $state(''),
		url = $state(''),
		busy = $state(false),
		error = $state(''),
		subscriptions = $state<
			{
				calendar_id: string;
				name: string;
				last_success: string | null;
				last_error: string | null;
			}[]
		>([]);
	async function load() {
		try {
			subscriptions = (
				await organizerRequest<{ subscriptions: typeof subscriptions }>(
					'/api/calendar/subscriptions'
				)
			).subscriptions;
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
	onMount(() => {
		void load();
		const timer = setInterval(load, 60000);
		return () => clearInterval(timer);
	});
	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await organizerRequest('/api/calendar/subscriptions', 'POST', { name, url });
			name = '';
			url = '';
			await load();
			onChange();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function remove(id: string) {
		if (!confirm('Remove this subscription and its local events?')) return;
		busy = true;
		try {
			await organizerRequest('/api/calendar/subscriptions', 'DELETE', { calendarId: id });
			await load();
			onChange();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<section>
	<h2>Subscribe to a calendar</h2>
	<p class="subtle">
		Add a public or secret HTTPS .ics link. Events are read-only and refresh hourly. A failed
		refresh keeps the last successful copy.
	</p>
	<form onsubmit={add}>
		<label>Name<input required maxlength="80" bind:value={name} /></label><label
			>Calendar URL<input required placeholder="https://…/calendar.ics" bind:value={url} /></label
		><button disabled={busy}>Subscribe</button>
	</form>
	{#if error}<p role="alert" class="error">{error}</p>{/if}{#each subscriptions as subscription}<div
			class="row"
		>
			<div>
				<strong>{subscription.name}</strong>
				<p class="subtle">
					{subscription.last_success
						? `Updated ${new Date(subscription.last_success).toLocaleString()}`
						: 'Waiting for first refresh'}
				</p>
				{#if subscription.last_error}<p class="error">{subscription.last_error}</p>{/if}
			</div>
			<button disabled={busy} onclick={() => remove(subscription.calendar_id)}>Remove</button>
		</div>{/each}
</section>

<style>
	section {
		display: grid;
		gap: 14px;
		border-top: 1px solid var(--color-line);
		padding-top: 20px;
		margin-top: 20px;
	}
	form {
		display: grid;
		gap: 12px;
	}
	.row {
		display: flex;
		justify-content: space-between;
		gap: 16px;
	}
	.error {
		color: var(--color-danger);
		font-size: 12px;
	}
</style>
