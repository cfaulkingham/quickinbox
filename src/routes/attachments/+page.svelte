<script lang="ts">
	import type { PageData } from './$types';
	import type { AttachmentSearchResult } from '$lib/server/attachment-browser';
	import AttachmentPreview from '$lib/components/AttachmentPreview.svelte';
	import { attachmentHref, isPreviewableInline } from '$lib/utils/attachments';
	import { formatFileSize } from '$lib/utils/html';
	import '$lib/organizer/organizer.css';
	let { data }: { data: PageData } = $props();
	let selected = $state<AttachmentSearchResult | null>(null);
	const link = (offset: number) =>
		`/attachments?q=${encodeURIComponent(data.q)}&kind=${encodeURIComponent(data.kind)}&offset=${offset}`;
</script>

<svelte:head><title>Attachments · Quickinbox</title></svelte:head>
<main class="organizer">
	<header class="organizer-header">
		<div>
			<h1>Attachments</h1>
			<p class="subtle">Find files by name, sender, or conversation.</p>
		</div>
	</header>
	<section class="files">
		<form class="actions" method="GET">
			<input
				type="search"
				name="q"
				aria-label="Search attachments"
				placeholder="Search files…"
				value={data.q}
			/><select name="kind" aria-label="File type" value={data.kind}
				><option value="">All files</option><option value="pdf">PDFs</option><option value="image"
					>Images</option
				></select
			><button>Search</button>
		</form>
		{#each data.files as file (file.id)}<article>
				<div>
					<strong>{file.filename}</strong>
					<p class="subtle">
						{formatFileSize(file.size_bytes)} · {file.from_addr} · {file.email_date.slice(0, 10)}
					</p>
					<a href={`/mail/${file.email_id}`}>{file.subject}</a>
				</div>
				<div class="actions">
					{#if isPreviewableInline(file.content_type)}<button onclick={() => (selected = file)}
							>Preview</button
						>{/if}<a
						class="button"
						href={attachmentHref(file.email_id, file.id, true)}
						download={file.filename}>Download</a
					>
				</div>
			</article>{:else}<p class="empty">No attachments match this search.</p>{/each}
		<nav class="actions">
			{#if data.offset}<a href={link(Math.max(0, data.offset - 50))}>Previous</a
				>{/if}{#if data.hasMore}<a href={link(data.offset + 50)}>Next</a>{/if}
		</nav>
	</section>
</main>
{#if selected}<AttachmentPreview
		emailId={selected.email_id}
		file={selected}
		onClose={() => (selected = null)}
	/>{/if}

<style>
	.files {
		overflow: auto;
		padding: 24px 28px;
	}
	form {
		margin-bottom: 24px;
	}
	form input {
		flex: 1;
	}
	form select {
		width: 130px;
	}
	.files article {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding: 20px 0;
		border-bottom: 1px solid var(--color-line);
	}
	article > div:first-child {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	a {
		font-size: 13px;
		text-decoration: underline;
	}
	p {
		padding: 6px 0;
	}
	.empty {
		padding: 40px 0;
	}
	nav {
		margin-top: 24px;
	}
	@media (max-width: 650px) {
		article {
			flex-direction: column;
			align-items: start !important;
		}
		form {
			flex-wrap: wrap;
		}
	}
</style>
