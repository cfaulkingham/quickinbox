<script lang="ts">
	import { untrack } from 'svelte';
	import type { PageData } from './$types';
	import type { MailTask } from '$lib/organizer/tasks';
	import { organizerRequest } from '$lib/organizer/client';
	import '$lib/organizer/organizer.css';
	let { data }: { data: PageData } = $props();
	let tasks = $state<MailTask[]>([]),
		hasMore = $state(false),
		kind = $state('task'),
		completed = $state(false),
		offset = $state(0),
		error = $state(''),
		notice = $state(''),
		busy = $state(false);
	let editing = $state(false),
		selected = $state<MailTask | null>(null),
		title = $state(''),
		notes = $state(''),
		due = $state(''),
		reminder = $state(''),
		source = $state<string | null>(null),
		taskId = $state('');
	const local = (iso: string | null) =>
		iso
			? new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60000)
					.toISOString()
					.slice(0, 16)
			: '';
	function edit(task: MailTask | null = null) {
		selected = task;
		editing = true;
		taskId = task?.id ?? crypto.randomUUID();
		title = task?.title ?? data.seed?.title ?? '';
		notes = task?.notes ?? data.seed?.notes ?? '';
		source = task?.source_email_id ?? data.seed?.id ?? null;
		due = local(task?.due_at ?? null);
		reminder = local(task?.reminder_at ?? null);
		if (!task && kind === 'followup') {
			due = local(new Date(Date.now() + 3 * 86400000).toISOString());
			reminder = due;
		}
		error = '';
	}
	$effect(() => {
		const current = data;
		untrack(() => {
			tasks = current.tasks;
			hasMore = current.hasMore;
			kind = current.kind;
			completed = false;
			offset = 0;
			editing = false;
			error = '';
			if (current.seed || current.selected) edit(current.selected);
		});
	});
	async function refresh() {
		const result = await organizerRequest<{ tasks: MailTask[]; hasMore: boolean }>(
			`/api/tasks?kind=${kind}&completed=${+completed}&offset=${offset}`
		);
		tasks = result.tasks;
		hasMore = result.hasMore;
	}
	async function filter() {
		offset = 0;
		try {
			await refresh();
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await organizerRequest(
				selected ? `/api/tasks/${selected.id}` : '/api/tasks',
				selected ? 'PUT' : 'POST',
				{
					id: taskId,
					version: selected?.version,
					kind: selected?.kind ?? kind,
					title,
					notes,
					sourceEmailId: source,
					dueAt: due ? new Date(due).toISOString() : null,
					reminderAt: reminder ? new Date(reminder).toISOString() : null,
					completed: !!selected?.completed_at
				}
			);
			editing = false;
			notice = 'Saved.';
			await refresh();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function finish(task: MailTask) {
		busy = true;
		error = '';
		try {
			await organizerRequest(`/api/tasks/${task.id}`, 'PUT', {
				version: task.version,
				kind: task.kind,
				title: task.title,
				notes: task.notes,
				sourceEmailId: task.source_email_id,
				dueAt: task.due_at,
				reminderAt: task.reminder_at,
				completed: !task.completed_at
			});
			await refresh();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function remove() {
		if (!selected || !confirm('Delete this task?')) return;
		busy = true;
		try {
			await organizerRequest(`/api/tasks/${selected.id}`, 'DELETE', { version: selected.version });
			editing = false;
			await refresh();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function next(delta: number) {
		offset = Math.max(0, offset + delta);
		try {
			await refresh();
		} catch (cause) {
			error = (cause as Error).message;
		}
	}
</script>

<svelte:head
	><title>{kind === 'followup' ? 'Waiting for reply' : 'Tasks'} · Quickinbox</title></svelte:head
>
<main class="organizer task-page">
	<header>
		<div>
			<p class="eyebrow">Your next steps</p>
			<h1>{kind === 'followup' ? 'Waiting for reply' : 'Tasks'}</h1>
			<p class="subtle">
				{kind === 'followup'
					? 'Follow-ups clear automatically when a new reply arrives.'
					: 'Keep work connected to the conversation.'}
			</p>
		</div>
		{#if kind === 'task'}<button class="primary" onclick={() => edit()}>New task</button>{/if}
	</header>
	<nav class="toolbar">
		<a href="/tasks" aria-current={kind === 'task' ? 'page' : undefined}>Tasks</a><a
			href="/tasks?kind=followup"
			aria-current={kind === 'followup' ? 'page' : undefined}>Waiting for reply</a
		><label class="check"
			><input type="checkbox" bind:checked={completed} onchange={filter} />Completed</label
		>
	</nav>
	{#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">
			{notice}
		</p>{/if}
	<div class="task-layout">
		<section class="task-list" aria-label="Tasks">
			{#each tasks as task (task.id)}<article>
					<button
						class="complete"
						disabled={busy}
						aria-label={task.completed_at ? `Reopen ${task.title}` : `Complete ${task.title}`}
						onclick={() => finish(task)}>{task.completed_at ? '✓' : '○'}</button
					>
					<div>
						<button class="task-title" onclick={() => edit(task)}>{task.title}</button
						>{#if task.due_at}<p class="subtle">
								Due {new Date(task.due_at).toLocaleString()}
							</p>{/if}{#if task.completion_reason === 'replied'}<p class="subtle">
								Reply received
							</p>{/if}{#if task.source_email_id}<a href={`/mail/${task.source_email_id}`}
								>Open conversation</a
							>{/if}
					</div>
				</article>{:else}<p class="empty">
					{completed
						? 'No completed items.'
						: kind === 'followup'
							? 'Open a sent message and choose Remind if no reply.'
							: 'No tasks yet. Create one here or from an email.'}
				</p>{/each}
			<div class="actions">
				{#if offset}<button onclick={() => next(-50)}>Previous</button>{/if}{#if hasMore}<button
						onclick={() => next(50)}>Next</button
					>{/if}
			</div>
		</section>
		{#if editing}<section class="task-editor">
				<h2>{selected ? 'Edit' : kind === 'followup' ? 'Follow up' : 'New task'}</h2>
				<form onsubmit={save}>
					<label>Title<input required maxlength="200" bind:value={title} /></label><label
						>Notes<textarea maxlength="8000" rows="6" bind:value={notes}></textarea></label
					><label>Due<input type="datetime-local" bind:value={due} /></label><label
						>Remind me<input
							type="datetime-local"
							required={kind === 'followup'}
							bind:value={reminder}
						/></label
					>
					<p class="subtle">
						Times use your device’s time zone. Reminders appear in the app and through browser push
						when enabled.
					</p>
					{#if source}<a href={`/mail/${source}`}>Open source email</a>{/if}
					<div class="actions">
						<button class="primary" disabled={busy}>Save</button><button
							type="button"
							onclick={() => (editing = false)}>Close</button
						>{#if selected}<button type="button" class="danger" disabled={busy} onclick={remove}
								>Delete</button
							>{/if}
					</div>
				</form>
			</section>{/if}
	</div>
</main>

<style>
	.task-page {
		max-width: 1200px;
		margin: auto;
		padding: 28px;
		width: 100%;
		overflow: auto;
	}
	header,
	.toolbar,
	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 24px;
	}
	.toolbar {
		justify-content: flex-start;
	}
	.toolbar a[aria-current] {
		font-weight: 700;
		text-decoration: underline;
	}
	.task-layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(280px, 400px);
		gap: 24px;
	}
	h1 {
		font-size: 28px;
	}
	h2 {
		font-size: 20px;
	}
	.eyebrow {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}
	article {
		display: flex;
		gap: 14px;
		padding: 18px 0;
		border-bottom: 1px solid var(--color-line);
	}
	.task-title {
		text-align: left;
		font-weight: 600;
	}
	.complete {
		font-size: 24px;
		align-self: start;
	}
	.task-editor {
		padding: 22px;
		background: var(--color-surface-muted);
		border-radius: 14px;
	}
	form,
	label {
		display: grid;
		gap: 8px;
	}
	form {
		gap: 18px;
	}
	.check {
		display: flex;
		align-items: center;
	}
	.empty {
		padding: 30px 0;
		color: var(--color-muted);
	}
	a {
		font-size: 13px;
		text-decoration: underline;
	}
	@media (max-width: 850px) {
		.task-layout {
			grid-template-columns: 1fr;
		}
		.task-editor {
			grid-row: 1;
		}
		.task-page {
			padding: 20px;
		}
	}
</style>
