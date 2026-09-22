<script lang="ts">
	import { onMount } from 'svelte';
	import type { MailAddress } from '$lib/types';
	import type { VacationSetting } from '$lib/server/vacation';
	import { organizerRequest } from '$lib/organizer/client';
	let { addresses }: { addresses: MailAddress[] } = $props();
	let settings = $state<VacationSetting[]>([]),
		addressId = $state(''),
		enabled = $state(false),
		start = $state(''),
		end = $state(''),
		subject = $state('Out of office'),
		body = $state(''),
		repeatDays = $state(7),
		version = $state(0),
		busy = $state(false),
		error = $state(''),
		notice = $state(''),
		failed = $state(0),
		loaded = $state(false);
	const local = (iso: string) =>
		new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60000)
			.toISOString()
			.slice(0, 16);
	function select() {
		const v = settings.find((v) => v.address_id === addressId);
		enabled = !!v?.enabled;
		start = local(v?.starts_at ?? new Date().toISOString());
		end = local(v?.ends_at ?? new Date(Date.now() + 7 * 86400000).toISOString());
		subject = v?.subject ?? 'Out of office';
		body = v?.body ?? '';
		repeatDays = v?.repeat_days ?? 7;
		version = v?.version ?? 0;
		notice = '';
	}
	onMount(() => {
		void organizerRequest<{ settings: VacationSetting[]; failed: number }>('/api/settings/vacation')
			.then((r) => {
				settings = r.settings;
				failed = r.failed;
				addressId = addresses[0]?.id ?? '';
				select();
				loaded = true;
			})
			.catch((c) => (error = c.message));
	});
	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const r = await organizerRequest<{ settings: VacationSetting[]; failed: number }>(
				'/api/settings/vacation',
				'PUT',
				{
					addressId,
					enabled,
					startsAt: new Date(start).toISOString(),
					endsAt: new Date(end).toISOString(),
					subject,
					body,
					repeatDays: Number(repeatDays),
					version
				}
			);
			settings = r.settings;
			failed = r.failed;
			select();
			notice = enabled ? 'Vacation responder saved.' : 'Vacation responder disabled.';
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<section class="vacation">
	<h2>Vacation responder</h2>
	<p>Send an automatic response while you’re away, with a separate message for each address.</p>
	{#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p role="status">
			{notice}
		</p>{/if}{#if failed}<p class="error">
			{failed} automatic responses could not reach Outbox. Check Admin → Maintenance and Worker logs.
		</p>{/if}
	{#if loaded && addresses.length}<form onsubmit={save}>
			<label
				>Address<select bind:value={addressId} onchange={select} disabled={busy}
					>{#each addresses as address}<option value={address.id}>{address.address}</option
						>{/each}</select
				></label
			><label class="check"
				><input type="checkbox" bind:checked={enabled} />Enable automatic responses</label
			>
			<div class="dates">
				<label>Starts<input type="datetime-local" required bind:value={start} /></label><label
					>Ends<input type="datetime-local" required bind:value={end} /></label
				>
			</div>
			<label>Subject<input required maxlength="200" bind:value={subject} /></label><label
				>Message<textarea required rows="5" maxlength="8000" bind:value={body}></textarea></label
			><label
				>Reply to the same sender at most once every <input
					type="number"
					min="1"
					max="30"
					required
					bind:value={repeatDays}
				/> days</label
			>
			<p>
				Dates use your device’s time zone. Only new mail addressed directly to this address is
				eligible. Mailing lists, automated messages, spam, and catch-all mail are skipped.
			</p>
			<button disabled={busy}>{busy ? 'Saving…' : 'Save vacation responder'}</button>
		</form>{/if}
</section>

<style>
	.vacation {
		padding: 24px;
		border: 1px solid var(--color-line);
		border-radius: 14px;
		margin: 20px 0;
		color: var(--color-text);
	}
	h2 {
		font-size: 16px;
		font-weight: 600;
		margin-bottom: 8px;
	}
	p {
		font-size: 12px;
		color: var(--color-text-secondary);
		margin: 10px 0;
	}
	form,
	label {
		display: grid;
		gap: 8px;
	}
	form {
		gap: 16px;
	}
	.dates {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}
	.check {
		display: flex;
		align-items: center;
	}
	input,
	textarea,
	select {
		padding: 9px;
		border: 1px solid var(--color-line);
		border-radius: 7px;
		background: var(--color-surface);
		color: var(--color-text);
	}
	input[type='number'] {
		width: 80px;
	}
	button {
		justify-self: start;
		background: var(--color-accent);
		color: var(--color-on-accent);
		padding: 10px 16px;
		border-radius: 8px;
	}
	.error {
		color: var(--color-danger);
	}
</style>
