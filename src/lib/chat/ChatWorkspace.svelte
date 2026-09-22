<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { organizerRequest as request } from '$lib/organizer/client';
	import {
		conversationTitle,
		type Conversation,
		type ChatMessage,
		type ChatPerson,
		type ChatEvent,
		type Meeting
	} from './types';
	import { chatConnected, chatUnread, sendTyping } from './client';
	let {
		userId,
		callsEnabled,
		compact = false,
		onClose
	}: {
		userId: string;
		callsEnabled: boolean;
		compact?: boolean;
		onClose?: () => void;
	} = $props();
	let conversations = $state<Conversation[]>([]),
		selectedId = $state(''),
		messages = $state<ChatMessage[]>([]);
	let meetings = $state<Meeting[]>([]),
		online = $state<string[]>([]),
		draft = $state(''),
		error = $state('');
	let loading = $state(true),
		sending = $state(false),
		calling = $state(false),
		hasMore = $state(false),
		olderBusy = $state(false);
	let newChat = $state(false),
		query = $state(''),
		people = $state<ChatPerson[]>([]),
		chosen = $state<ChatPerson[]>([]),
		title = $state(''),
		creating = $state(false);
	let searching = $state(false),
		typing = $state(''),
		log: HTMLDivElement | undefined = $state();
	let moreConversations = $state(false),
		conversationsBusy = $state(false);
	let conversationCursor: { updatedAt: string; id: string } | null = null;
	let alive = true,
		selection = 0,
		searchRun = 0,
		readSeq = 0,
		typingTimer: ReturnType<typeof setTimeout>;
	let retry: { id: string; body: string; conversationId: string } | null = null;
	const selected = $derived(conversations.find((c) => c.id === selectedId));
	const totalUnread = $derived($chatUnread);
	async function refreshList(older = false) {
		const cursor =
			older && conversationCursor
				? `?before=${encodeURIComponent(conversationCursor.updatedAt)}&id=${conversationCursor.id}`
				: '';
		const result = await request<{
			conversations: Conversation[];
			hasMore: boolean;
		}>(`/api/chat${cursor}`);
		if (!alive) return;
		const initial = !conversationCursor;
		const merged = new Map(conversations.map((c) => [c.id, c]));
		for (const chat of result.conversations) merged.set(chat.id, chat);
		conversations = [...merged.values()].sort(
			(a, b) =>
				b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)
		);
		if (older || initial) {
			moreConversations = result.hasMore;
			const last = result.conversations.at(-1);
			if (last)
				conversationCursor = { updatedAt: last.updated_at, id: last.id };
		}
	}
	async function loadMoreConversations() {
		conversationsBusy = true;
		try {
			await refreshList(true);
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			conversationsBusy = false;
		}
	}
	async function readVisible() {
		const seq = messages.at(-1)?.seq || 0,
			id = selectedId;
		if (
			document.hidden ||
			!id ||
			seq <= readSeq ||
			(log && log.scrollHeight - log.scrollTop - log.clientHeight > 80)
		)
			return;
		readSeq = seq;
		try {
			await request(`/api/chat/${id}`, 'PATCH', { seq });
			if (id === selectedId)
				conversations = conversations.map((c) =>
					c.id === id ? { ...c, unread: 0 } : c
				);
		} catch {
			if (id === selectedId) readSeq = 0;
		}
	}
	async function refreshRoom(older = false) {
		const id = selectedId,
			run = selection;
		if (!id) return;
		const nearBottom =
			!log || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
		const after = !older ? messages.at(-1)?.seq || 0 : 0;
		const result = await request<{
			messages: ChatMessage[];
			hasMore: boolean;
			online: string[];
			meetings: Meeting[];
			conversation: Conversation;
		}>(
			`/api/chat/${id}${older ? `?before=${messages[0]?.seq || 0}` : after ? `?after=${after}` : ''}`
		);
		if (!alive || run !== selection) return;
		if (!conversations.some((c) => c.id === id))
			conversations = [result.conversation, ...conversations];
		const previousHeight = log?.scrollHeight || 0;
		const merged = new Map(messages.map((m) => [m.seq, m]));
		for (const message of result.messages) merged.set(message.seq, message);
		messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
		if (older || !after) hasMore = result.hasMore;
		online = result.online;
		meetings = result.meetings;
		await tick();
		if (log && older) log.scrollTop += log.scrollHeight - previousHeight;
		else if (log && nearBottom) log.scrollTop = log.scrollHeight;
		if (after && result.hasMore) await refreshRoom();
		else await readVisible();
	}
	async function select(id: string) {
		selection++;
		selectedId = id;
		messages = [];
		meetings = [];
		hasMore = false;
		readSeq = 0;
		draft = '';
		retry = null;
		typing = '';
		error = '';
		loading = true;
		try {
			await refreshRoom();
		} catch (cause) {
			if (id === selectedId) error = (cause as Error).message;
		} finally {
			if (id === selectedId) loading = false;
		}
	}
	async function send() {
		if (!draft.trim() || sending || !selectedId) return;
		const id = selectedId,
			text = draft.trim();
		if (!retry || retry.body !== text || retry.conversationId !== id)
			retry = { id: crypto.randomUUID(), body: text, conversationId: id };
		sending = true;
		error = '';
		try {
			await request(`/api/chat/${id}`, 'POST', retry);
			if (selectedId === id) {
				draft = '';
				retry = null;
				await refreshRoom();
				await tick();
				if (log) log.scrollTop = log.scrollHeight;
			}
			await refreshList();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			sending = false;
		}
	}
	async function create() {
		creating = true;
		error = '';
		try {
			const { id } = await request<{ id: string }>('/api/chat', 'POST', {
				userIds: chosen.map((p) => p.id),
				title
			});
			await refreshList();
			newChat = false;
			chosen = [];
			query = '';
			title = '';
			await select(id);
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			creating = false;
		}
	}
	async function call(audioOnly: boolean) {
		if (!selected) return;
		calling = true;
		error = '';
		try {
			const { meeting } = await request<{ meeting: Meeting }>(
				'/api/meetings',
				'POST',
				{
					title: conversationTitle(selected, userId),
					conversationId: selectedId,
					audioOnly
				}
			);
			window.open(`/meet/${meeting.id}`, '_blank', 'noopener');
			await refreshRoom();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			calling = false;
		}
	}
	async function loadOlder() {
		olderBusy = true;
		try {
			await refreshRoom(true);
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			olderBusy = false;
		}
	}
	$effect(() => {
		const term = query.trim(),
			run = ++searchRun;
		people = [];
		if (!term) {
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(async () => {
			try {
				const result = await request<{ people: ChatPerson[] }>(
					`/api/chat/people?q=${encodeURIComponent(term)}`
				);
				if (alive && run === searchRun) people = result.people;
			} catch (cause) {
				if (run === searchRun) error = (cause as Error).message;
			} finally {
				if (run === searchRun) searching = false;
			}
		}, 250);
		return () => clearTimeout(timer);
	});
	onMount(() => {
		alive = true;
		void (async () => {
			try {
				await refreshList();
				const id = new URL(location.href).searchParams.get('conversation');
				if (id && /^[a-f0-9-]{36}$/i.test(id)) await select(id);
			} catch (cause) {
				error = (cause as Error).message;
			} finally {
				loading = false;
			}
		})();
		let refreshing = false;
		const refresh = async () => {
			if (document.hidden || refreshing) return;
			refreshing = true;
			try {
				await refreshList();
				await refreshRoom();
			} catch (cause) {
				error = (cause as Error).message;
			} finally {
				refreshing = false;
			}
		};
		const listener = (event: Event) => {
			const detail = (event as CustomEvent<ChatEvent>).detail;
			if (detail.type === 'typing') {
				if (detail.conversationId === selectedId) {
					typing = `${detail.name} is typing…`;
					clearTimeout(typingTimer);
					typingTimer = setTimeout(() => (typing = ''), 4000);
				}
			} else void refresh();
		};
		window.addEventListener('quickinbox-chat', listener);
		document.addEventListener('visibilitychange', refresh);
		const timer = setInterval(refresh, 15_000);
		return () => {
			alive = false;
			selection++;
			clearInterval(timer);
			clearTimeout(typingTimer);
			window.removeEventListener('quickinbox-chat', listener);
			document.removeEventListener('visibilitychange', refresh);
		};
	});
</script>

<section class="chat-workspace" class:compact aria-label="Chat">
	<header class="chat-header">
		<div>
			<h1>
				Chat {#if totalUnread}<span class="badge">{totalUnread}</span>{/if}
			</h1>
			<small
				><span class:connected={$chatConnected} class="dot"
				></span>{$chatConnected ? 'Connected' : 'Checking for updates'}</small
			>
		</div>
		<div class="actions">
			<button onclick={() => (newChat = !newChat)}>New chat</button
			>{#if onClose}<button aria-label="Close chat" onclick={onClose}>✕</button
				>{/if}
		</div>
	</header>
	{#if error}<div role="alert" class="chat-error">
			{error}<button aria-label="Dismiss error" onclick={() => (error = '')}
				>✕</button
			>
		</div>{/if}
	{#if newChat}<form
			class="new-chat"
			onsubmit={(e) => {
				e.preventDefault();
				void create();
			}}
		>
			<label
				>Find people<input
					type="search"
					bind:value={query}
					placeholder="Search accounts by name or email"
				/></label
			>
			{#if searching}<small>Searching…</small
				>{:else if query && !people.length}<small
					>No matching accounts on this server.</small
				>{/if}
			<div class="people-results">
				{#each people.filter((p) => !chosen.some((c) => c.id === p.id)) as person}<button
						type="button"
						disabled={chosen.length >= 7}
						onclick={() => (chosen = [...chosen, person])}
						>{person.name}<small>{person.email}</small></button
					>{/each}
			</div>
			<div class="chosen">
				{#each chosen as person}<button
						type="button"
						onclick={() => (chosen = chosen.filter((p) => p.id !== person.id))}
						>{person.name} ×</button
					>{/each}
			</div>
			{#if chosen.length > 1}<label
					>Group name<input
						maxlength="100"
						bind:value={title}
						placeholder="Project team"
					/></label
				>{/if}
			<div class="actions">
				<button class="primary" disabled={!chosen.length || creating}
					>{creating ? 'Creating…' : 'Start conversation'}</button
				><button type="button" onclick={() => (newChat = false)}>Cancel</button>
			</div>
		</form>{/if}
	<div class="chat-body" class:has-selection={!!selectedId}>
		<aside class="conversation-list" aria-label="Conversations">
			{#each conversations as conversation}<button
					class:active={conversation.id === selectedId}
					onclick={() => select(conversation.id)}
					><span class="avatar"
						>{conversationTitle(conversation, userId)
							.slice(0, 1)
							.toUpperCase()}</span
					><span class="conversation-preview"
						><strong>{conversationTitle(conversation, userId)}</strong><small
							>{conversation.latest_body || 'Say hello'}</small
						></span
					>{#if conversation.unread}<span class="badge"
							>{conversation.unread}</span
						>{/if}</button
				>{/each}
			{#if moreConversations}<button
					disabled={conversationsBusy}
					onclick={loadMoreConversations}
					>{conversationsBusy ? 'Loading…' : 'Load more conversations'}</button
				>{/if}
			{#if !conversations.length && !loading}<p class="empty-list">
					Start a conversation with someone on this server.
				</p>{/if}
		</aside>
		<div class="conversation">
			{#if selected}
				<div class="room-header">
					<button
						class="back"
						onclick={() => {
							selection++;
							selectedId = '';
						}}>← Chats</button
					>
					<div class="room-title">
						<strong>{conversationTitle(selected, userId)}</strong><small
							>{selected.members
								.filter((p) => p.id !== userId)
								.map(
									(p) => `${p.name}${online.includes(p.id) ? ' · online' : ''}`
								)
								.join(', ')}</small
						>
					</div>
					<div class="actions">
						<button
							title={callsEnabled
								? 'Start audio call'
								: 'Calling is not configured'}
							aria-label="Start audio call"
							disabled={!callsEnabled || calling}
							onclick={() => call(true)}>☎</button
						><button
							disabled={!callsEnabled || calling}
							onclick={() => call(false)}
							>{calling ? 'Starting…' : 'Video call'}</button
						>
					</div>
				</div>
				{#if meetings.length}<div class="active-calls">
						{#each meetings as meeting}<a
								href={`/meet/${meeting.id}`}
								target="_blank"
								rel="noopener"
								>Join {meeting.audio_only ? 'audio' : 'video'} call ↗</a
							>{/each}
					</div>{/if}
				<div
					class="messages"
					role="log"
					aria-label="Messages"
					aria-live="polite"
					bind:this={log}
					onscroll={() => void readVisible()}
				>
					{#if hasMore}<button
							class="older"
							disabled={olderBusy}
							onclick={loadOlder}
							>{olderBusy ? 'Loading…' : 'Load earlier messages'}</button
						>{/if}
					{#if loading}<p class="empty-list">
							Loading messages…
						</p>{:else if !messages.length}<div class="conversation-empty">
							<strong>A conversation starts with hello.</strong>
							<p>Messages stay here so you can pick up where you left off.</p>
						</div>{/if}
					{#each messages as message (message.id)}<article
							class:own={message.sender_id === userId}
						>
							<div class="message-meta">
								<strong
									>{message.sender_id === userId
										? 'You'
										: message.sender_name}</strong
								><time
									datetime={message.created_at}
									title={new Date(message.created_at).toLocaleString()}
									>{new Date(message.created_at).toLocaleTimeString([], {
										hour: 'numeric',
										minute: '2-digit'
									})}</time
								>
							</div>
							<p>{message.body}</p>
						</article>{/each}
				</div>
				<div class="typing" aria-live="polite">{typing}</div>
				<form
					class="composer"
					onsubmit={(e) => {
						e.preventDefault();
						void send();
					}}
				>
					<textarea
						aria-label="Message"
						placeholder="Write a message…"
						rows="2"
						maxlength="4000"
						bind:value={draft}
						disabled={sending}
						oninput={() => sendTyping(selectedId)}
						onkeydown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
								e.preventDefault();
								void send();
							}
						}}></textarea><button
						class="primary"
						disabled={sending || !draft.trim()}
						>{sending ? 'Sending…' : 'Send'}</button
					>
				</form>
				<small class="composer-hint"
					>Enter to send · Shift+Enter for a new line</small
				>
			{:else}<div class="welcome">
					<div class="welcome-icon">✦</div>
					<h2>A little closer, wherever you work.</h2>
					<p>
						Message your team, share an update, or turn a conversation into a
						call.
					</p>
					<button class="primary" onclick={() => (newChat = true)}
						>Start a chat</button
					>{#if !callsEnabled}<small
							>Audio and video will be available when your administrator enables
							calling.</small
						>{/if}
				</div>{/if}
		</div>
	</div>
</section>

<style>
	.chat-workspace {
		flex: 1;
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		color: var(--color-text, #202323);
		background: var(--color-surface, #fff);
		font-size: 14px;
	}
	.chat-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 22px 26px;
		border-bottom: 1px solid var(--color-line, #e5e7eb);
	}
	h1 {
		font-size: 24px;
		margin: 0 0 5px;
		letter-spacing: -0.6px;
	}
	small {
		font-size: 12px;
		color: var(--color-text-secondary, #717575);
	}
	button,
	input,
	textarea {
		font: inherit;
	}
	button {
		cursor: pointer;
		border: 1px solid var(--color-line, #ddd);
		background: var(--color-surface, #fff);
		color: inherit;
		border-radius: 8px;
		padding: 9px 12px;
	}
	button:hover {
		background: var(--color-surface-hover, #f4f6f5);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.primary {
		background: #2f6652;
		color: white;
		border-color: #2f6652;
	}
	.primary:hover {
		background: #265443;
	}
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		background: #b3b8b5;
		border-radius: 50%;
		margin-right: 6px;
	}
	.connected {
		background: #55a47b;
	}
	.badge {
		font-size: 11px;
		border-radius: 20px;
		background: #e1eee6;
		color: #275c43;
		padding: 3px 7px;
	}
	.chat-body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.conversation-list {
		width: 250px;
		flex-shrink: 0;
		border-right: 1px solid var(--color-line, #e5e7eb);
		overflow: auto;
		padding: 10px;
	}
	.conversation-list > button {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 10px;
		border: 0;
		text-align: left;
		padding: 13px 10px;
		margin-bottom: 4px;
	}
	.conversation-list .active {
		background: var(--color-surface-hover, #edf3ee);
	}
	.avatar {
		flex-shrink: 0;
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: 11px;
		background: #dfece4;
		color: #35634a;
		font-weight: 600;
	}
	.conversation-preview {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 5px;
	}
	.conversation-preview strong,
	.conversation-preview small {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.conversation {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.room-header {
		padding: 16px 20px;
		display: flex;
		align-items: center;
		gap: 12px;
		border-bottom: 1px solid var(--color-line, #e5e7eb);
	}
	.room-title {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.room-title strong,
	.room-title small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.messages {
		flex: 1;
		overflow: auto;
		padding: 22px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.messages article {
		max-width: 85%;
		align-self: flex-start;
	}
	.messages .own {
		align-self: flex-end;
	}
	.message-meta {
		display: flex;
		gap: 10px;
		font-size: 11px;
		margin: 0 2px 5px;
		color: var(--color-text-secondary, #717575);
	}
	.message-meta strong {
		font-weight: 500;
	}
	.messages p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.6;
		margin: 0;
		padding: 11px 15px;
		border-radius: 4px 14px 14px 14px;
		background: var(--color-surface-muted, #f1f3f2);
	}
	.messages .own p {
		background: #e4efe8;
		color: #223f2d;
		border-radius: 14px 4px 14px 14px;
	}
	.composer {
		display: flex;
		gap: 10px;
		padding: 0 20px;
		align-items: flex-end;
	}
	textarea {
		resize: vertical;
		min-height: 48px;
		max-height: 160px;
		flex: 1;
		min-width: 0;
		border: 1px solid var(--color-line, #ddd);
		border-radius: 10px;
		padding: 12px;
		background: transparent;
		color: inherit;
	}
	.composer-hint {
		padding: 8px 22px 15px;
		font-size: 10px;
	}
	.typing {
		min-height: 22px;
		padding: 0 22px;
		font-size: 12px;
		color: var(--color-text-secondary, #717575);
	}
	.welcome {
		margin: auto;
		text-align: center;
		max-width: 400px;
		padding: 30px;
	}
	.welcome h2 {
		font-size: 25px;
		font-weight: 500;
		letter-spacing: -0.7px;
	}
	.welcome p {
		color: var(--color-text-secondary, #717575);
		line-height: 1.7;
	}
	.welcome small {
		display: block;
		line-height: 1.6;
		margin-top: 24px;
	}
	.welcome-icon {
		font-size: 46px;
		color: #739985;
	}
	.empty-list {
		padding: 20px;
		line-height: 1.6;
		color: var(--color-text-secondary, #717575);
	}
	.conversation-empty {
		text-align: center;
		margin: auto;
		color: var(--color-text-secondary, #717575);
	}
	.conversation-empty p {
		background: none;
		font-size: 12px;
	}
	.new-chat {
		padding: 18px 24px;
		border-bottom: 1px solid var(--color-line, #ddd);
		max-height: 50%;
		overflow: auto;
		display: grid;
		gap: 12px;
	}
	.new-chat label {
		display: grid;
		gap: 6px;
	}
	input {
		width: 100%;
		padding: 10px;
		border: 1px solid var(--color-line, #ddd);
		border-radius: 8px;
		background: transparent;
		color: inherit;
		box-sizing: border-box;
	}
	.people-results {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.people-results button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
	}
	.chosen {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.chosen button {
		background: #e4efe8;
		color: #223f2d;
		padding: 5px 9px;
	}
	.chat-error {
		background: #fff1ed;
		color: #8c3821;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 22px;
	}
	.chat-error button {
		border: 0;
		background: none;
	}
	.active-calls {
		padding: 9px 20px;
		background: var(--color-surface-muted, #f1f5f2);
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	.active-calls a {
		color: #387256;
		font-weight: 500;
	}
	.older {
		align-self: center;
		font-size: 12px;
	}
	.back {
		display: none;
	}
	.compact .conversation-list {
		width: 205px;
	}
	.compact .chat-header {
		padding: 14px 18px;
	}
	.compact h1 {
		font-size: 19px;
	}
	@media (max-width: 700px) {
		.conversation-list {
			width: 100%;
			box-sizing: border-box;
			border: 0;
		}
		.chat-body:not(.has-selection) .conversation {
			display: none;
		}
		.has-selection .conversation-list {
			display: none;
		}
		.back {
			display: block;
			padding: 6px;
		}
		.room-header {
			padding: 12px;
			flex-wrap: wrap;
		}
		.room-title {
			min-width: 100px;
		}
		.messages {
			padding: 16px;
		}
		.chat-header {
			padding: 16px;
		}
		.composer {
			padding: 0 12px;
		}
		.compact .conversation-list {
			width: 100%;
		}
	}
</style>
