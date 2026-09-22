<script lang="ts">
	import { page } from '$app/stores';
	import { chatUnread } from '$lib/chat/client';
	import { t } from '$lib/i18n';
	import Icon from './Icon.svelte';
	import Tooltip from './Tooltip.svelte';

	let { theme = 'classic' }: { theme?: 'classic' | 'zero' } = $props();
	const items = $derived([
		...($page.data.chatEnabled ? [
			{ href: '/chat', icon: 'chat-3-line', label: 'Chat' },
			{ href: '/meetings', icon: 'video-chat-line', label: 'Meetings' }
		] : []),
		{ href: '/calendar', icon: 'calendar-line', label: t('nav.calendar') },
		{ href: '/tasks', icon: 'checkbox-circle-line', label: t('nav.tasks') },
		{ href: '/contacts', icon: 'contacts-book-line', label: t('nav.contacts'), tooltip: t('nav.contactsAddressBook') }
	]);
</script>

<nav class="organizer-rail" class:classic={theme === 'classic'} class:zero={theme === 'zero'} aria-label={t('nav.organizer')}>
	{#each items as item (item.href)}
		{@const active = $page.url.pathname === item.href || $page.url.pathname.startsWith(`${item.href}/`)}
		<Tooltip text={item.tooltip ?? item.label} side="left">
			<a href={item.href} class="rail-link" class:active aria-label={item.label} aria-current={active ? 'page' : undefined}>
				<Icon name={item.icon} size={21} />
				{#if item.href === '/chat' && $chatUnread}<span class="unread">{$chatUnread > 99 ? '99+' : $chatUnread}</span>{/if}
			</a>
		</Tooltip>
	{/each}
</nav>

<style>
	.organizer-rail {
		display: flex;
		flex: 0 0 var(--organizer-rail-width);
		flex-direction: column;
		align-items: center;
		gap: 0.625rem;
		width: var(--organizer-rail-width);
		padding: 0.75rem 0;
		background: var(--color-surface);
		border-left: 1px solid var(--color-line);
	}
	.classic {
		position: fixed;
		inset: 0 0 0 auto;
		z-index: 30;
	}
	.zero { background: var(--z-sidebar); border-left: none; }
	.rail-link {
		position: relative;
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		color: var(--color-text-secondary);
		transition: background 0.15s, color 0.15s;
	}
	.rail-link:hover { background: var(--color-surface-hover); color: var(--color-text); }
	.unread { position: absolute; top: -3px; right: -5px; font-size: 9px; padding: 2px 5px; border-radius: 12px; background: var(--color-accent); color: var(--color-accent-foreground, white); }
	.rail-link.active { background: var(--color-accent-soft); color: var(--color-accent-text); }
	.rail-link.active::after {
		content: '';
		position: absolute;
		left: -0.5rem;
		top: 0.625rem;
		bottom: 0.625rem;
		width: 3px;
		border-radius: 2px;
		background: var(--color-accent);
	}
	.rail-link:focus-visible { outline: 2px solid var(--color-accent-text); outline-offset: 2px; }
	@media (max-width: 900px) { .classic { display: none; } }
	@media (max-width: 767px) { .zero { display: none; } }
	@media (prefers-reduced-motion: reduce) { .rail-link { transition: none; } }
</style>
