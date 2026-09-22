<script lang="ts">
	import PdfPreview from './PdfPreview.svelte';
	import { onMount } from 'svelte';
	import type { EmailAttachmentMeta } from '$lib/types';
	import { attachmentHref, isImageType } from '$lib/utils/attachments';
	let {
		emailId,
		file,
		onClose
	}: { emailId: string; file: EmailAttachmentMeta; onClose: () => void } = $props();
	let dialog: HTMLDialogElement,
		failed = $state(false);
	const href = $derived(attachmentHref(emailId, file.id));
	onMount(() => {
		dialog.showModal();
		return () => dialog?.close();
	});
</script>

<dialog bind:this={dialog} onclose={onClose} aria-label={`Preview ${file.filename}`}>
	<header>
		<strong>{file.filename}</strong><a
			href={attachmentHref(emailId, file.id, true)}
			download={file.filename}>Download</a
		><button onclick={() => dialog.close()} aria-label="Close preview">✕</button>
	</header>
	{#if failed}<p role="alert">
			This file could not be previewed. Try downloading it.
		</p>{:else if isImageType(file.content_type)}<img
			src={href}
			alt={file.filename}
			onerror={() => (failed = true)}
		/>{:else if file.content_type
		.toLowerCase()
		.split(';')[0]
		.trim() === 'application/pdf'}<PdfPreview url={href} />{:else}<iframe
			title={file.filename}
			src={href}
			sandbox="allow-scripts"
			referrerpolicy="no-referrer"
			onerror={() => (failed = true)}
		></iframe>
		<p>If your browser cannot display this file, use Download.</p>{/if}
</dialog>

<style>
	dialog {
		margin: auto;
		width: min(1100px, 94vw);
		height: 88vh;
		max-height: 88vh;
		padding: 0;
		border: 1px solid var(--color-line);
		border-radius: 14px;
		background: var(--color-surface);
		color: var(--color-text);
	}
	dialog[open] {
		display: flex;
		flex-direction: column;
	}
	dialog::backdrop {
		background: rgba(0, 0, 0, 0.65);
	}
	header {
		display: flex;
		align-items: center;
		gap: 20px;
		padding: 16px;
		border-bottom: 1px solid var(--color-line);
	}
	strong {
		flex: 1;
		overflow-wrap: anywhere;
	}
	a,
	button {
		font-size: 13px;
	}
	a {
		text-decoration: underline;
	}
	button {
		padding: 8px;
		cursor: pointer;
	}
	img {
		width: 100%;
		min-height: 0;
		flex: 1;
		object-fit: contain;
	}
	iframe {
		width: 100%;
		flex: 1;
		border: 0;
		background: white;
	}
	p {
		padding: 10px;
		font-size: 12px;
		color: var(--color-text-secondary);
	}
</style>
