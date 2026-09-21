<script lang="ts">
	import { onDestroy } from 'svelte';
	import { organizerRequest } from './client';
	import type { Contact } from './types';
	let {
		group = '',
		onDone,
		onClose
	}: { group?: string; onDone: () => void; onClose: () => void } = $props();
	let contacts = $state<Partial<Contact>[]>([]),
		issues = $state<{ row: number; message: string }[]>([]),
		busy = $state(false),
		message = $state(''),
		error = $state('');
	let active = true;
	onDestroy(() => {
		active = false;
	});
	async function preview(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		contacts = [];
		issues = [];
		error = '';
		message = '';
		busy = true;
		try {
			if (file.size > 2 * 1024 * 1024) throw new Error('Choose a file up to 2 MB.');
			const result = await organizerRequest<{
				contacts: Partial<Contact>[];
				issues: typeof issues;
			}>('/api/contacts/transfer', 'POST', {
				source: await file.text(),
				format: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'vcf'
			});
			if (active) {
				contacts = result.contacts;
				issues = result.issues;
			}
		} catch (cause) {
			error = (cause as Error).message;
		} finally {
			busy = false;
		}
	}
	async function importFile() {
		busy = true;
		error = '';
		let imported = 0,
			skipped = 0;
		try {
			for (let offset = 0; active && offset < contacts.length; offset += 25) {
				const result = await organizerRequest<{
					imported: number;
					skipped: number;
					issues: typeof issues;
				}>('/api/contacts/transfer', 'POST', contacts.slice(offset, offset + 25));
				imported += result.imported;
				skipped += result.skipped;
				issues = [
					...issues,
					...result.issues.map((issue) => ({ ...issue, row: issue.row + offset }))
				];
				message = `${imported} imported · ${skipped} existing contacts skipped`;
			}
			if (active) {
				contacts = [];
				onDone();
			}
		} catch (cause) {
			error = `${(cause as Error).message} Completed batches are saved; retrying skips existing contacts.`;
			onDone();
		} finally {
			busy = false;
		}
	}
</script>

<section class="transfer" aria-label="Import and export contacts">
	<div class="actions">
		<strong>Move your address book</strong><button onclick={onClose} disabled={busy}>Close</button>
	</div>
	<p class="subtle">
		Preview UTF-8 vCard or Google Contacts CSV files (up to 2 MB / 2,000 contacts). Existing email
		addresses are skipped.
	</p>
	<div class="actions">
		<label
			>Import file<input
				type="file"
				accept=".vcf,.vcard,.csv"
				onchange={preview}
				disabled={busy}
			/></label
		><a
			class="button"
			href={`/api/contacts/transfer?format=vcf&group=${encodeURIComponent(group)}`}
			download>Export vCard{group ? ` · ${group}` : ''}</a
		><a
			class="button"
			href={`/api/contacts/transfer?format=csv&group=${encodeURIComponent(group)}`}
			download>Export Google CSV</a
		>
	</div>
	{#if contacts.length}<p>
			{contacts.length} valid contacts: {contacts
				.slice(0, 5)
				.map((c) => c.name || c.emails?.[0])
				.join(', ')}{contacts.length > 5 ? '…' : ''}
		</p>
		<button class="primary" disabled={busy} onclick={importFile}
			>{busy ? 'Importing…' : `Import ${contacts.length} contacts`}</button
		>{/if}
	{#if message}<p role="status">{message}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
	{#if issues.length}<details>
			<summary>{issues.length} rows need attention</summary>{#each issues as issue}<p>
					Row {issue.row}: {issue.message}
				</p>{/each}
		</details>{/if}
</section>

<style>
	.transfer {
		margin: 12px 24px;
		padding: 18px;
		border: 1px solid var(--color-line);
		border-radius: 12px;
		display: grid;
		gap: 12px;
		max-height: 45vh;
		overflow: auto;
		flex-shrink: 0;
	}
	strong {
		flex: 1;
	}
	[role='alert'] {
		color: var(--color-danger);
	}
</style>
