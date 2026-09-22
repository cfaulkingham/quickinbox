<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import ChatWorkspace from './ChatWorkspace.svelte';
	import { chatUnread, chatConnected, setChatSocket } from './client';
	import type { ChatEvent } from './types';
	import { organizerRequest } from '$lib/organizer/client';
	let { userId, callsEnabled }: { userId: string; callsEnabled: boolean } =
		$props();
	let open = $state(false),
		incoming = $state<Extract<ChatEvent, { type: 'call' }> | null>(null);
	onMount(() => {
		let stopped = false,
			socket: WebSocket | null = null,
			retry: ReturnType<typeof setTimeout>,
			callTimer: ReturnType<typeof setTimeout>,
			failures = 0;
		const refresh = async () => {
			if (document.hidden) return;
			try {
				const result = await organizerRequest<{ unread: number }>(
					'/api/chat?unread=1'
				);
				if (!stopped) chatUnread.set(result.unread);
			} catch {
				/* Next refresh recovers temporary failures. */
			}
		};
		const connect = () => {
			if (stopped) return;
			socket = new WebSocket(
				`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/chat/socket`
			);
			socket.onopen = () => {
				failures = 0;
				chatConnected.set(true);
				setChatSocket(socket);
				void refresh();
				window.dispatchEvent(
					new CustomEvent('quickinbox-chat', {
						detail: { type: 'changed', conversationId: '' }
					})
				);
			};
			socket.onmessage = (event) => {
				if (event.data === 'pong') return;
				let message: ChatEvent;
				try {
					message = JSON.parse(event.data);
				} catch {
					return;
				}
				window.dispatchEvent(
					new CustomEvent('quickinbox-chat', { detail: message })
				);
				if (message.type !== 'typing') void refresh();
				if (message.type === 'call') {
					incoming = message;
					clearTimeout(callTimer);
					callTimer = setTimeout(() => (incoming = null), 30_000);
				}
			};
			socket.onclose = () => {
				chatConnected.set(false);
				setChatSocket(null);
				if (!stopped)
					retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** failures++));
			};
			socket.onerror = () => socket?.close();
		};
		connect();
		void refresh();
		const poll = setInterval(refresh, 30_000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			stopped = true;
			clearTimeout(retry);
			clearTimeout(callTimer);
			clearInterval(poll);
			document.removeEventListener('visibilitychange', refresh);
			socket?.close();
			setChatSocket(null);
			chatConnected.set(false);
			chatUnread.set(0);
		};
	});
</script>

{#if incoming}<aside
		class="call-notice"
		aria-label="Incoming call"
		role="status"
	>
		<div>
			<strong
				>{incoming.name} started {incoming.audioOnly ? 'an audio' : 'a video'} call</strong
			><small>Join when you’re ready.</small>
		</div>
		<a
			href={`/meet/${incoming.meetingId}`}
			target="_blank"
			rel="noopener"
			onclick={() => (incoming = null)}>Join call</a
		><button onclick={() => (incoming = null)}>Dismiss</button>
	</aside>{/if}
{#if $page.url.pathname !== '/chat'}
	{#if open}<aside class="chat-dock" aria-label="Chat panel">
			<ChatWorkspace
				{userId}
				{callsEnabled}
				compact
				onClose={() => (open = false)}
			/>
		</aside>{/if}
	<button
		class="chat-launcher"
		class:opened={open}
		aria-expanded={open}
		onclick={() => (open = !open)}
		>Chat{#if $chatUnread}<span>{$chatUnread}</span>{/if}</button
	>
{/if}

<style>
	.chat-launcher {
		position: fixed;
		bottom: 18px;
		right: 24px;
		z-index: 65;
		padding: 10px 18px;
		border: 1px solid var(--color-line, #dce3df);
		border-radius: 24px;
		background: var(--color-surface, #fff);
		color: var(--color-text, #263a2e);
		box-shadow: 0 3px 18px #0001;
		font-family: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.chat-launcher span {
		background: #32664e;
		color: #fff;
		border-radius: 20px;
		padding: 2px 6px;
	}
	.opened {
		background: #32664e;
		color: #fff;
	}
	.chat-dock {
		position: fixed;
		bottom: 70px;
		right: 24px;
		width: min(760px, calc(100vw - 48px));
		height: min(650px, calc(100dvh - 120px));
		border: 1px solid var(--color-line, #ddd);
		border-radius: 14px;
		overflow: hidden;
		z-index: 64;
		box-shadow: 0 15px 70px #0003;
		background: var(--color-surface, #fff);
	}
	.call-notice {
		position: fixed;
		top: 20px;
		right: 24px;
		z-index: 90;
		background: var(--color-surface, #fff);
		color: var(--color-text, #222);
		border: 1px solid #729b80;
		padding: 18px;
		border-radius: 14px;
		display: flex;
		align-items: center;
		gap: 14px;
		box-shadow: 0 8px 32px #0002;
		max-width: calc(100vw - 48px);
	}
	.call-notice div {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.call-notice small {
		opacity: 0.7;
	}
	.call-notice a {
		background: #32664e;
		color: #fff;
		padding: 9px 12px;
		border-radius: 8px;
		white-space: nowrap;
	}
	.call-notice button {
		background: none;
		color: inherit;
		border: 0;
		cursor: pointer;
	}
	@media (max-width: 900px) {
		.chat-launcher {
			bottom: calc(76px + env(safe-area-inset-bottom));
			right: 16px;
		}
		.chat-dock {
			bottom: calc(128px + env(safe-area-inset-bottom));
			right: 10px;
			width: calc(100vw - 20px);
			height: calc(100dvh - 205px);
		}
		.call-notice {
			right: 12px;
			top: 12px;
			flex-wrap: wrap;
			font-size: 13px;
		}
	}
</style>
