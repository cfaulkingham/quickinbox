<script lang="ts">
	import { onMount } from 'svelte';
	import type { MailTask } from './tasks';
	import { organizerRequest } from './client';
	let reminders = $state<MailTask[]>([]),
		error = $state('');
	onMount(() => {
		let active = true;
		async function refresh() {
			if (document.visibilityState !== 'visible') return;
			try {
				const r = await organizerRequest<{ reminders: MailTask[] }>('/api/tasks/reminders');
				if (active) reminders = r.reminders;
			} catch {}
		}
		void refresh();
		const timer = setInterval(refresh, 60000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			active = false;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', refresh);
		};
	});
	async function act(task: MailTask, snooze = false) {
		try {
			await organizerRequest('/api/tasks/reminders', 'POST', {
				id: task.id,
				version: task.version,
				snooze
			});
			reminders = reminders.filter((r) => r.id !== task.id);
			error = '';
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
</script>

{#if reminders.length}<aside aria-label="Task reminders" aria-live="polite">
		{#each reminders.slice(0, 2) as task (task.id)}<div>
				<a href={`/tasks?task=${task.id}&kind=${task.kind}`}
					><small>{task.kind === 'followup' ? 'Time to follow up' : 'Task reminder'}</small
					>{task.title}</a
				><button onclick={() => act(task, true)}>10 min</button><button
					onclick={() => act(task)}
					aria-label={`Dismiss ${task.title}`}>✕</button
				>
			</div>{/each}{#if error}<p role="alert">{error}</p>{/if}
	</aside>{/if}

<style>
	aside {
		position: fixed;
		left: 24px;
		bottom: 24px;
		z-index: 151;
		width: min(360px, calc(100vw - 48px));
		display: grid;
		gap: 8px;
	}
	aside div {
		display: flex;
		gap: 12px;
		align-items: start;
		padding: 16px;
		background: var(--color-surface);
		border: 1px solid var(--color-line);
		border-radius: 12px;
		box-shadow: var(--shadow-md);
	}
	a {
		display: grid;
		gap: 5px;
		flex: 1;
		font-size: 14px;
	}
	small {
		font-size: 11px;
		color: var(--color-muted);
	}
	button {
		font-size: 12px;
		white-space: nowrap;
	}
	p {
		background: var(--color-surface);
		color: var(--color-danger);
	}
	@media (max-width: 900px) {
		aside {
			bottom: auto;
			top: 76px;
			left: 16px;
			width: calc(100vw - 32px);
		}
	}
</style>
