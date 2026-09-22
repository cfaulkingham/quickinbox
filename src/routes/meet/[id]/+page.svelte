<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import type RealtimeKitClient from '@cloudflare/realtimekit';
	import type { RtkMeeting } from '@cloudflare/realtimekit-ui/components/rtk-meeting';
	import { organizerRequest as request } from '$lib/organizer/client';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let name = $state(''),
		busy = $state(false),
		error = $state(''),
		joined = $state(false),
		camera = $state(false),
		microphone = $state(true);
	let container: HTMLDivElement | undefined = $state(),
		client: RealtimeKitClient | null = null,
		alive = true;
	$effect(() => {
		name = data.displayName;
	});
	async function join() {
		busy = true;
		error = '';
		try {
			const result = await request<{ token: string; audioOnly: boolean }>(
				`/meet/${data.meeting.id}/join`,
				'POST',
				{ name }
			);
			const [{ default: Client }, { defineCustomElements }] = await Promise.all(
				[
					import('@cloudflare/realtimekit'),
					import('@cloudflare/realtimekit-ui/loader')
				]
			);
			if (!alive) return;
			// Register the full UI: its renderer creates video, device and screen-share elements dynamically.
			await defineCustomElements();
			const meeting = await Client.init({
				authToken: result.token,
				defaults: { audio: microphone, video: camera && !result.audioOnly }
			});
			if (!alive) {
				await meeting.leave();
				return;
			}
			client = meeting;
			joined = true;
			await tick();
			const element = document.createElement('rtk-meeting') as RtkMeeting;
			element.meeting = meeting;
			element.showSetupScreen = true;
			element.mode = 'fill';
			element.leaveOnUnmount = true;
			element.applyDesignSystem = false;
			container?.replaceChildren(element);
		} catch (cause) {
			error =
				(cause as Error).message ||
				'Could not join. Check your connection and browser permissions.';
			await client?.leave().catch(() => {});
			client = null;
			joined = false;
		} finally {
			busy = false;
		}
	}
	async function leave() {
		await client?.leave().catch(() => {});
		client = null;
		container?.replaceChildren();
		joined = false;
	}
	async function end() {
		busy = true;
		error = '';
		try {
			await request(`/api/meetings/${data.meeting.id}`, 'DELETE', {});
			await leave();
			location.assign('/meetings');
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	onDestroy(() => {
		alive = false;
		void client?.leave().catch(() => {});
	});
</script>

<svelte:head
	><title>{data.meeting.title} · Quickinbox Meet</title><meta
		name="robots"
		content="noindex,nofollow"
	/><meta name="referrer" content="no-referrer" /></svelte:head
>
<main class="meeting-page">
	<header>
		<a href="/meetings">Quickinbox <span>Meet</span></a><strong
			>{data.meeting.title}</strong
		>
		<div>
			{#if joined}<button onclick={leave}>Leave call</button
				>{/if}{#if data.isOwner}<button disabled={busy} onclick={end}
					>End for everyone</button
				>{/if}
		</div>
	</header>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if joined}<div
			class="meeting-container"
			bind:this={container}
		></div>{:else}<form
			class="join-card"
			onsubmit={(e) => {
				e.preventDefault();
				void join();
			}}
		>
			<div class="symbol">✦</div>
			<p class="eyebrow">YOU’RE INVITED</p>
			<h1>{data.meeting.title}</h1>
			<p>
				Take a moment to get ready. You can preview your devices before entering
				the call.
			</p>
			<label
				>Your name<input
					bind:value={name}
					required
					maxlength="80"
					autocomplete="name"
					readonly={!!data.displayName}
				/></label
			>
			<div class="devices">
				<label
					><input type="checkbox" bind:checked={microphone} />Microphone on</label
				>{#if !data.meeting.audioOnly}<label
						><input type="checkbox" bind:checked={camera} />Camera on</label
					>{/if}
			</div>
			<button class="primary" disabled={busy || !name.trim()}
				>{busy ? 'Preparing your call…' : 'Continue to call'}</button
			><small
				>{data.meeting.guestsAllowed
					? 'Anyone with this link can join. Guest names are self-reported.'
					: 'This call is private to the conversation.'}</small
			>
		</form>{/if}
</main>

<style>
	.meeting-page {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: #f4f6f4;
		color: #233329;
		font-family: inherit;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding: 18px 26px;
		background: white;
		border-bottom: 1px solid #e0e6e1;
	}
	header a {
		color: #284f38;
		font-weight: 650;
		text-decoration: none;
		white-space: nowrap;
	}
	header span {
		font-weight: 400;
		color: #74847a;
		margin-left: 4px;
	}
	header strong {
		font-weight: 500;
		font-size: 14px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	header div {
		display: flex;
		gap: 8px;
	}
	button {
		font: inherit;
		border: 1px solid #d5dfd8;
		border-radius: 8px;
		background: white;
		color: #314c3a;
		padding: 10px 14px;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.join-card {
		max-width: 410px;
		margin: auto;
		padding: 30px;
		text-align: center;
	}
	.symbol {
		font-size: 44px;
		color: #739b7f;
	}
	.eyebrow {
		font-size: 10px;
		letter-spacing: 2px;
		color: #6e8777;
	}
	h1 {
		font-size: 32px;
		font-weight: 500;
		letter-spacing: -1px;
		margin: 16px 0;
	}
	.join-card > p {
		line-height: 1.7;
		color: #778079;
		font-size: 14px;
	}
	.join-card > label {
		text-align: left;
		display: grid;
		gap: 8px;
		font-size: 13px;
		margin: 24px 0 16px;
	}
	input:not([type='checkbox']) {
		padding: 12px;
		border: 1px solid #d5dfd8;
		border-radius: 8px;
		font: inherit;
		background: white;
		color: #233329;
	}
	.devices {
		display: flex;
		justify-content: center;
		gap: 20px;
		font-size: 13px;
		margin: 20px 0;
	}
	.devices label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.primary {
		width: 100%;
		background: #32664e;
		color: white;
		border-color: #32664e;
		padding: 13px;
	}
	.join-card small {
		display: block;
		color: #7b857e;
		line-height: 1.6;
		margin-top: 20px;
		font-size: 11px;
	}
	.meeting-container {
		flex: 1;
		min-height: 0;
		position: relative;
	}
	.meeting-container :global(rtk-meeting) {
		display: block;
		width: 100%;
		height: 100%;
		position: absolute;
		inset: 0;
	}
	.error {
		color: #a23d29;
		text-align: center;
		margin: 12px;
		padding: 12px;
		background: #fff1ec;
		border-radius: 8px;
	}
	@media (max-width: 600px) {
		header {
			padding: 12px;
			flex-wrap: wrap;
		}
		header strong {
			order: 3;
			width: 100%;
		}
		.join-card {
			padding: 24px;
		}
		.meeting-page {
			overflow: auto;
		}
	}
</style>
