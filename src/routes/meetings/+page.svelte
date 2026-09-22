<script lang="ts">
	import { onMount } from 'svelte';
	import { organizerRequest as request } from '$lib/organizer/client';
	import type { Meeting } from '$lib/chat/types';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let meetings = $state<Meeting[]>([]),
		title = $state(''),
		guestsAllowed = $state(false),
		busy = $state(false),
		error = $state(''),
		notice = $state('');
	let days = $state(1);
	$effect(() => {
		meetings = data.meetings;
	});
	async function refresh() {
		const result = await request<{ meetings: Meeting[] }>('/api/meetings');
		meetings = result.meetings;
	}
	async function create() {
		busy = true;
		error = '';
		notice = '';
		try {
			const { meeting } = await request<{ meeting: Meeting }>(
				'/api/meetings',
				'POST',
				{
					title,
					guestsAllowed,
					expiresAt: new Date(Date.now() + days * 86400_000).toISOString()
				}
			);
			meetings = [meeting, ...meetings];
			title = '';
			notice = 'Meeting created. Copy the link to invite your guests.';
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function copy(id: string) {
		try {
			await navigator.clipboard.writeText(`${location.origin}/meet/${id}`);
			notice = 'Meeting link copied.';
		} catch {
			error = 'Could not copy. Open the meeting and copy its address.';
		}
	}
	async function end(id: string) {
		busy = true;
		error = '';
		try {
			await request(`/api/meetings/${id}`, 'DELETE', {});
			await refresh();
			notice = 'Meeting ended for everyone.';
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		const timer = setInterval(() => {
			if (!document.hidden) void refresh().catch(() => {});
		}, 30_000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head><title>Meetings · Quickinbox</title></svelte:head>
<div class="meetings-page">
	<header>
		<div class="eyebrow">QUICKINBOX MEETINGS</div>
		<h1>Make room for a conversation.</h1>
		<p>
			Bring people together with a link. No mailbox account needed for invited
			guests.
		</p>
	</header>
	{#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p
			class="notice"
			role="status"
		>
			{notice}
		</p>{/if}
	{#if !data.callsEnabled}<section class="setup">
			<h2>Calling is not enabled yet</h2>
			<p>
				Your administrator can connect Cloudflare RealtimeKit to enable audio,
				video, and screen sharing. Chat is ready to use.
			</p>
			<a href="/chat">Open Chat →</a>
		</section>
	{:else}<form
			onsubmit={(e) => {
				e.preventDefault();
				void create();
			}}
		>
			<h2>Create a meeting</h2>
			<label
				>Meeting name<input
					bind:value={title}
					required
					maxlength="100"
					placeholder="Design catch-up"
				/></label
			><label
				>Link expires<select bind:value={days}
					><option value={1}>In 24 hours</option><option value={7}
						>In 7 days</option
					><option value={30}>In 30 days</option></select
				></label
			><label class="checkbox"
				><input type="checkbox" bind:checked={guestsAllowed} />Allow anyone with
				the link to join as a guest</label
			><small>For a private call, start from an existing chat.</small><button
				class="primary"
				disabled={busy || !title.trim() || !guestsAllowed}
				>{busy ? 'Creating…' : 'Create meeting link'}</button
			>
		</form>{/if}
	<section class="meeting-list">
		<h2>Your meetings</h2>
		{#if !meetings.length}<p>
				No active meetings. Start a call in Chat or create a link above.
			</p>{/if}{#each meetings as meeting}<article>
				<div>
					<h3>{meeting.title}</h3>
					<p>
						{meeting.guests_allowed
							? 'Guests with the link can join'
							: 'Conversation members only'} · Expires {new Date(
							meeting.expires_at
						).toLocaleDateString()}
					</p>
				</div>
				<div class="actions">
					<a
						class="primary"
						href={`/meet/${meeting.id}`}
						target="_blank"
						rel="noopener">Join ↗</a
					><button onclick={() => copy(meeting.id)}>Copy link</button
					>{#if meeting.owner_id === data.user?.id}<button
							disabled={busy}
							onclick={() => end(meeting.id)}>End meeting</button
						>{/if}
				</div>
			</article>{/each}
	</section>
</div>

<style>
	.meetings-page {
		flex: 1;
		width: 100%;
		min-width: 0;
		height: 100%;
		overflow: auto;
		padding: 42px clamp(20px, 5vw, 70px);
		box-sizing: border-box;
		color: var(--color-text, #242c28);
		background: var(--color-surface, #fff);
	}
	header {
		max-width: 650px;
		margin-bottom: 30px;
	}
	.eyebrow {
		font-size: 11px;
		letter-spacing: 2px;
		color: #608b70;
		font-weight: 600;
	}
	h1 {
		font-size: clamp(28px, 3vw, 40px);
		font-weight: 500;
		letter-spacing: -1.3px;
		line-height: 1.15;
		margin: 14px 0;
	}
	p {
		color: var(--color-text-secondary, #707974);
		line-height: 1.7;
	}
	h2 {
		font-size: 18px;
		margin: 0 0 18px;
	}
	form,
	.setup {
		border: 1px solid var(--color-line, #dce3df);
		border-radius: 14px;
		padding: 25px;
		max-width: 600px;
		display: grid;
		gap: 16px;
		background: var(--color-surface-muted, #f8faf8);
	}
	label {
		display: grid;
		gap: 7px;
		font-size: 13px;
	}
	.checkbox {
		display: flex;
		align-items: center;
	}
	.checkbox input {
		width: auto;
	}
	input,
	select {
		padding: 11px;
		border: 1px solid var(--color-line, #dce3df);
		border-radius: 7px;
		font: inherit;
		background: var(--color-surface, #fff);
		color: inherit;
	}
	small {
		color: var(--color-text-secondary, #707974);
	}
	button,
	a.primary {
		padding: 10px 14px;
		border: 1px solid var(--color-line, #dce3df);
		border-radius: 8px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		text-decoration: none;
	}
	.primary {
		background: #32664e !important;
		color: #fff !important;
		border-color: #32664e !important;
		justify-self: start;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.meeting-list {
		margin-top: 36px;
	}
	.meeting-list > p {
		font-size: 14px;
	}
	article {
		padding: 22px 0;
		display: flex;
		justify-content: space-between;
		gap: 20px;
		align-items: center;
		border-bottom: 1px solid var(--color-line, #ddd);
	}
	h3 {
		font-size: 16px;
		margin: 0;
	}
	article p {
		font-size: 12px;
		margin: 6px 0 0;
	}
	.actions {
		display: flex;
		gap: 8px;
		font-size: 12px;
		flex-wrap: wrap;
	}
	.error {
		color: #a3412e;
	}
	.notice {
		color: #32664e;
	}
	.setup a {
		color: #32664e;
	}
	@media (max-width: 700px) {
		.meetings-page {
			padding: 24px 18px 110px;
		}
		article {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
