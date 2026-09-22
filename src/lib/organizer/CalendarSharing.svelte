<script lang="ts">
	import type { PersonalCalendar } from './types';
	import { organizerRequest } from './client';
	let { calendars }: { calendars: PersonalCalendar[] } = $props();
	let calendarId = $state(''),
		email = $state(''),
		permission = $state('read'),
		shares = $state<{ email: string; name: string; permission: string }[]>([]),
		feedEnabled = $state(false),
		feedUrl = $state(''),
		error = $state(''),
		busy = $state(false);
	async function load() {
		const selectedId = calendarId;
		error = '';
		feedUrl = '';
		shares = [];
		feedEnabled = false;
		if (!calendarId) return;
		try {
			const r = await organizerRequest<{ shares: typeof shares; feedEnabled: boolean }>(
				`/api/calendar/sharing?calendar=${encodeURIComponent(selectedId)}`
			);
			if (calendarId !== selectedId) return;
			shares = r.shares;
			feedEnabled = r.feedEnabled;
		} catch (cause) {
			if (calendarId === selectedId) error = (cause as Error).message;
		}
	}
	async function share(target = email, role = permission) {
		busy = true;
		error = '';
		try {
			const r = await organizerRequest<{ shares: typeof shares }>('/api/calendar/sharing', 'POST', {
				calendarId,
				email: target,
				permission: role
			});
			shares = r.shares;
			email = '';
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function feed(enabled: boolean) {
		busy = true;
		error = '';
		try {
			const r = await organizerRequest<{ token: string | null }>('/api/calendar/sharing', 'POST', {
				calendarId,
				feed: enabled
			});
			feedEnabled = enabled;
			feedUrl = r.token ? `${location.origin}/calendar-feed/${r.token}` : '';
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<section class="sharing">
	<h2>Sharing & subscription link</h2>
	<p class="subtle">
		Share a named calendar with another account on this server, or subscribe to it from another
		calendar app.
	</p>
	<label
		>Calendar<select bind:value={calendarId} onchange={load} disabled={busy}
			><option value="">Choose your calendar</option
			>{#each calendars.filter((c) => !c.access || c.access === 'owner') as calendar}<option
					value={calendar.id}>{calendar.name}</option
				>{/each}</select
		></label
	>
	{#if error}<p role="alert" class="error">{error}</p>{/if}{#if calendarId}<form
			class="actions"
			onsubmit={(e) => {
				e.preventDefault();
				void share();
			}}
		>
			<label>Account email<input type="email" required bind:value={email} /></label><label
				>Permission<select bind:value={permission}
					><option value="read">Can view</option><option value="write"
						>Can edit & invite guests</option
					></select
				></label
			><button disabled={busy}>Share</button>
		</form>
		<p class="subtle">
			Editors can change events and send invitations using the event organizer’s address.
		</p>
		{#each shares as member}<div class="actions">
				<span>{member.email} · {member.permission === 'write' ? 'Can edit' : 'Can view'}</span
				><button disabled={busy} onclick={() => share(member.email, 'remove')}>Remove access</button
				>
			</div>{/each}
		<div class="actions">
			<button disabled={busy} onclick={() => feed(true)}
				>{feedEnabled ? 'Replace subscription link' : 'Create subscription link'}</button
			>{#if feedEnabled}<button disabled={busy} onclick={() => feed(false)}>Revoke link</button
				>{/if}
		</div>
		{#if feedUrl}<label
				>Subscription URL<input
					readonly
					value={feedUrl}
					onclick={(e) => e.currentTarget.select()}
				/></label
			>{/if}
		<p class="subtle">
			Anyone with this link can read this calendar’s event details and guests. Replacing or revoking
			the link stops future access; downloaded copies remain in other apps.
		</p>{/if}
</section>

<style>
	.sharing {
		display: grid;
		gap: 14px;
		border-top: 1px solid var(--color-line);
		padding-top: 20px;
		margin-top: 20px;
	}
	.error {
		color: var(--color-danger);
	}
	form label {
		flex: 1;
	}
	span {
		flex: 1;
		font-size: 13px;
	}
</style>
