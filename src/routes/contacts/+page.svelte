<script lang="ts">
	import { untrack, tick } from 'svelte';
	import type { PageData } from './$types';
	import type { Contact } from '$lib/organizer/types';
	import { organizerRequest } from '$lib/organizer/client';
	import '$lib/organizer/organizer.css';
	import ContactTransfer from '$lib/organizer/ContactTransfer.svelte';
	let { data }: { data: PageData } = $props();
	let contacts = $state<Contact[]>(untrack(() => data.contacts));
	let total = $state(untrack(() => data.total));
	let query = $state(''),
		appliedQuery = '',
		searchRun = 0;
	let selected = $state<Contact | null>(null),
		editing = $state(false);
	let name = $state(''),
		emails = $state(''),
		company = $state(''),
		phone = $state(''),
		notes = $state(''),
		starred = $state(false);
	let busy = $state(false),
		error = $state(''),
		notice = $state('');
	let owner = untrack(() => data.user?.id);
	let seededRoute = '';
	let contactBody: HTMLDivElement | undefined;
	function revealEditor() {
		void tick().then(() => {
			if (window.matchMedia('(max-width: 800px)').matches) contactBody?.scrollTo({ top: 0 });
		});
	}
	let birthday = $state(''),
		groupText = $state(''),
		group = $state(''),
		favorites = $state(false);
	let groups = $state<string[]>(untrack(() => data.groups)),
		picked = $state<Contact[]>([]),
		merging = $state(false),
		transferring = $state(false),
		duplicates = $state<Contact[][]>([]),
		checkedDuplicates = $state(false);
	async function findDuplicates() {
		const current = owner;
		try {
			const result = await organizerRequest<{ duplicates: Contact[][] }>('/api/contacts/merge');
			if (current === owner) {
				duplicates = result.duplicates;
				checkedDuplicates = true;
			}
		} catch (cause) {
			if (current === owner) error = (cause as Error).message;
		}
	}
	function pick(contact: Contact, checked: boolean) {
		picked = checked ? [...picked, contact] : picked.filter((c) => c.id !== contact.id);
	}
	async function merge() {
		busy = true;
		error = '';
		const current = owner;
		try {
			const result = await organizerRequest<{ contact: Contact }>(
				'/api/contacts/merge',
				'POST',
				picked.map(({ id, version }) => ({ id, version }))
			);
			if (current !== owner) return;
			picked = [];
			duplicates = [];
			checkedDuplicates = false;
			merging = false;
			edit(result.contact);
			notice = 'Contacts merged. Conflicting details are preserved in notes.';
			await load();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		const current = data.user?.id;
		if (current !== owner)
			untrack(() => {
				owner = current;
				groups = data.groups;
				group = '';
				favorites = false;
				picked = [];
				merging = false;
				transferring = false;
				duplicates = [];
				checkedDuplicates = false;
				searchRun++;
				contacts = data.contacts;
				total = data.total;
				query = '';
				appliedQuery = '';
				selected = null;
				editing = false;
				busy = false;
				error = '';
				notice = '';
			});
	});
	$effect(() => {
		const route = JSON.stringify([data.user?.id, data.seed.email]);
		if (route !== seededRoute) {
			seededRoute = route;
			untrack(() => {
				if (data.existing) edit(data.existing);
				else if (data.seed.email) {
					create();
					name = data.seed.name;
					emails = data.seed.email;
				}
			});
		}
	});
	function create() {
		revealEditor();
		selected = null;
		editing = true;
		name = '';
		emails = '';
		company = '';
		phone = '';
		notes = '';
		starred = false;
		birthday = '';
		groupText = '';
		error = '';
	}
	function edit(contact: Contact) {
		revealEditor();
		selected = contact;
		editing = true;
		({ name, company, phone, notes, starred } = contact);
		birthday = contact.birthday;
		groupText = contact.groups.join(', ');
		emails = contact.emails.join(', ');
		error = '';
	}
	async function load(more = false) {
		const run = ++searchRun;
		try {
			const search = more ? appliedQuery : query;
			const result = await organizerRequest<{
				contacts: Contact[];
				total: number;
				groups: string[];
			}>(
				`/api/contacts?q=${encodeURIComponent(search)}&offset=${more ? contacts.length : 0}&group=${encodeURIComponent(group)}&favorites=${favorites ? 1 : 0}`
			);
			if (run !== searchRun) return;
			contacts = more ? [...contacts, ...result.contacts] : result.contacts;
			total = result.total;
			groups = result.groups;
			appliedQuery = search;
		} catch (cause) {
			if (run === searchRun) error = (cause as Error).message;
		}
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		const savingOwner = owner;
		try {
			const result = await organizerRequest<{ contact: Contact }>(
				selected ? `/api/contacts/${selected.id}` : '/api/contacts',
				selected ? 'PUT' : 'POST',
				{
					name,
					emails: emails
						.split(/[,;\n]/)
						.map((s) => s.trim())
						.filter(Boolean),
					company,
					phone,
					notes,
					starred,
					birthday,
					groups: groupText
						.split(',')
						.map((g) => g.trim())
						.filter(Boolean),
					version: selected?.version
				}
			);
			if (savingOwner !== owner) return;
			edit(result.contact);
			notice = 'Contact saved. Available in recipient suggestions.';
			await load();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function remove() {
		if (!selected || busy || !confirm(`Delete ${selected.name} from your contacts?`)) return;
		busy = true;
		error = '';
		try {
			await organizerRequest(`/api/contacts/${selected.id}`, 'DELETE', {
				version: selected.version
			});
			editing = false;
			selected = null;
			notice = 'Contact deleted.';
			await load();
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Contacts — Quickinbox</title></svelte:head>
<div class="organizer contacts-page">
	<header class="organizer-header">
		<div>
			<h1>Contacts</h1>
			<p class="subtle">Your address book, connected to mail and calendar.</p>
		</div>
		<div class="actions">
			<button onclick={findDuplicates}>Find duplicates</button><button
				onclick={() => (transferring = !transferring)}>Import / Export</button
			><button class="primary" onclick={create}>+ New contact</button>
		</div>
	</header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if transferring}<ContactTransfer
			{group}
			onDone={() => load()}
			onClose={() => (transferring = false)}
		/>{/if}
	<div class="contacts-body" class:editing bind:this={contactBody}>
		<section class="contact-list" aria-label="Address book">
			<form
				class="contact-search"
				onsubmit={(event) => {
					event.preventDefault();
					void load();
				}}
			>
				<input
					aria-label="Search contacts"
					type="search"
					placeholder="Search name, email, or company"
					bind:value={query}
				/><button>Search</button>
			</form>
			<div class="actions filters">
				<select aria-label="Contact group" bind:value={group} onchange={() => load()}
					><option value="">All groups</option>{#each groups as name}<option value={name}
							>{name}</option
						>{/each}</select
				>
				<label class="check"
					><input type="checkbox" bind:checked={favorites} onchange={() => load()} /> Favorites</label
				>
				{#if picked.length}<button
						onclick={() => (merging = true)}
						disabled={picked.length < 2 || picked.length > 20}
						>Merge selected ({picked.length})</button
					><button
						onclick={() => {
							picked = [];
							merging = false;
						}}>Clear selection</button
					>{/if}
			</div>
			{#if checkedDuplicates}<div class="duplicate-list">
					<p class="subtle">
						{duplicates.length
							? 'Review contacts with matching names before merging.'
							: 'No matching-name duplicates found.'}
					</p>
					{#each duplicates as group}<button
							onclick={() => {
								picked = group;
								merging = true;
							}}>{group[0].name} · {group.length} contacts</button
						>{/each}
				</div>{/if}
			{#if merging}<div class="merge-preview" role="region" aria-label="Merge preview">
					<label
						>Keep primary contact<select
							value={picked[0]?.id}
							onchange={(e) => {
								const id = e.currentTarget.value;
								picked = [
									...picked.filter((c) => c.id === id),
									...picked.filter((c) => c.id !== id)
								];
							}}
							>{#each picked as contact}<option value={contact.id}
									>{contact.name} · {contact.emails[0] ||
										contact.phone ||
										'No email address'}</option
								>{/each}</select
						></label
					>
					<p class="subtle">
						Combine emails, groups and notes from {picked
							.map((c) => `${c.name} (${c.emails.join(', ') || c.phone || 'no email'})`)
							.join('; ')}. The other contacts will be removed.
					</p>
					<button disabled={busy || picked.length < 2} onclick={merge}>Confirm merge</button><button
						onclick={() => (merging = false)}>Cancel</button
					>
				</div>{/if}
			<p class="contact-count subtle">{total} {total === 1 ? 'contact' : 'contacts'}</p>
			{#each contacts as contact (contact.id)}
				<div class="contact-item">
					<input
						type="checkbox"
						aria-label={`Select ${contact.name}`}
						checked={picked.some((c) => c.id === contact.id)}
						onchange={(e) => pick(contact, e.currentTarget.checked)}
					/><button
						class="contact-row"
						class:chosen={selected?.id === contact.id}
						onclick={() => edit(contact)}
					>
						<span class="avatar">{contact.name.charAt(0).toUpperCase()}</span><span
							class="contact-info"
							><strong>{contact.name}</strong><span class="subtle"
								>{contact.emails[0] || contact.phone || 'No email address'}</span
							>{#if contact.company}<small>{contact.company}</small>{/if}</span
						>{#if contact.starred}<span aria-label="Favorite">★</span>{/if}
					</button>
				</div>
			{:else}<div class="empty">
					<h2>{query ? 'No matching contacts' : 'Keep your people close'}</h2>
					<p class="subtle">
						{query
							? 'Try a different name or email address.'
							: 'Add a contact here, or save someone directly from a message.'}
					</p>
				</div>{/each}
			{#if contacts.length < total}<div class="load-more">
					<button onclick={() => load(true)}>Load more</button>
				</div>{/if}
		</section>
		{#if editing}
			<section class="editor" aria-label="Contact details">
				<div class="editor-head">
					<h2>{selected ? 'Contact details' : 'New contact'}</h2>
					<button onclick={() => (editing = false)} aria-label="Close contact">✕</button>
				</div>
				{#if selected?.emails.length}<div class="inline-links">
						<a href={`/compose?to=${encodeURIComponent(selected.emails[0])}`}>Write email</a><a
							href={`/calendar?guest=${encodeURIComponent(selected.emails[0])}`}>Schedule event</a
						>
					</div>{/if}
				<form onsubmit={save}>
					<div class="form-grid">
						<label class="wide"
							>Name<input bind:value={name} maxlength="200" autocomplete="name" /></label
						>
						<label class="wide"
							>Email addresses<input
								bind:value={emails}
								placeholder="name@example.com, work@example.com"
							/><span class="subtle">Separate multiple addresses with commas.</span></label
						>
						<label
							>Company<input
								bind:value={company}
								maxlength="200"
								autocomplete="organization"
							/></label
						><label
							>Phone<input
								type="tel"
								bind:value={phone}
								maxlength="100"
								autocomplete="tel"
							/></label
						>
						<label>Birthday<input type="date" bind:value={birthday} /></label><label
							>Groups<input bind:value={groupText} placeholder="Friends, Work" /><span
								class="subtle">Separate groups with commas.</span
							></label
						>
						<label class="wide"
							>Notes<textarea bind:value={notes} maxlength="4000"></textarea></label
						><label class="check wide"
							><input type="checkbox" bind:checked={starred} /> Favorite contact</label
						>
					</div>
					<div class="actions">
						<button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save contact'}</button
						>{#if selected}<button class="danger" type="button" disabled={busy} onclick={remove}
								>Delete</button
							>{/if}
					</div>
				</form>
			</section>
		{/if}
	</div>
</div>

<style>
	.duplicate-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding-block: 12px;
	}
	.contact-item {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.filters select {
		width: auto;
		max-width: 220px;
	}
	.merge-preview {
		margin: 12px 0;
		padding: 16px;
		background: var(--color-accent-soft);
		border-radius: 8px;
		display: grid;
		gap: 10px;
	}
	.contacts-body {
		display: grid;
		grid-template-columns: 1fr;
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.contacts-body.editing {
		grid-template-columns: minmax(250px, 1fr) minmax(320px, 1fr);
	}
	.contact-list {
		overflow: auto;
		padding: 8px 20px 24px;
	}
	.contact-search {
		display: flex;
		gap: 8px;
		padding: 12px 0;
		position: sticky;
		top: 0;
		background: var(--color-surface);
	}
	.contact-count {
		padding: 8px 4px 16px;
	}
	.contact-list .contact-row {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		text-align: left;
		padding: 14px 12px;
		border: 0;
		border-bottom: 1px solid var(--color-line);
		border-radius: 0;
	}
	.contact-list .chosen {
		background: var(--color-accent-soft);
		border-radius: 8px;
	}
	.avatar {
		width: 40px;
		height: 40px;
		flex: none;
		display: grid;
		place-items: center;
		background: var(--color-surface-muted);
		border-radius: 50%;
		color: var(--color-accent-text);
	}
	.contact-info {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow-wrap: anywhere;
	}
	.editor {
		border-left: 1px solid var(--color-line);
	}
	.load-more {
		padding: 20px;
		text-align: center;
	}
	@media (max-width: 800px) {
		.contacts-body.editing {
			display: flex;
			flex-direction: column;
			overflow: auto;
		}
		.contact-list,
		.editor {
			overflow: visible;
		}
		.editor {
			order: -1;
			flex: none;
			border-left: 0;
			border-bottom: 1px solid var(--color-line);
		}
	}
</style>
