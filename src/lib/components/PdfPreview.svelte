<script lang="ts">
	import { onMount } from 'svelte';
	import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
	import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
	let { url }: { url: string } = $props();
	let canvas: HTMLCanvasElement;
	let pdf: PDFDocumentProxy | undefined,
		loadingTask: PDFDocumentLoadingTask | undefined,
		renderTask: RenderTask | undefined;
	let page = $state(1),
		pages = $state(0),
		busy = $state(true),
		error = $state('');
	let alive = true;
	async function render(number: number) {
		if (!pdf || (busy && pages === 0)) return;
		busy = true;
		error = '';
		try {
			const sheet = await pdf.getPage(number);
			if (!alive) return;
			const natural = sheet.getViewport({ scale: 1 });
			const scale = Math.min(2, 2000 / Math.max(natural.width, natural.height));
			const viewport = sheet.getViewport({ scale });
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			renderTask = sheet.render({ canvas, viewport });
			await renderTask.promise;
			if (alive) page = number;
		} catch (cause) {
			if (alive) error = 'This PDF could not be displayed. Download it to open in another reader.';
		} finally {
			if (alive) busy = false;
		}
	}
	onMount(() => {
		void (async () => {
			try {
				const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist');
				if (!alive) return;
				GlobalWorkerOptions.workerSrc = workerUrl;
				loadingTask = getDocument({
					url,
					withCredentials: true,
					cMapUrl: '/pdf-assets/cmaps/',
					cMapPacked: true,
					standardFontDataUrl: '/pdf-assets/standard_fonts/',
					wasmUrl: '/pdf-assets/wasm/',
					enableXfa: false,
					maxImageSize: 16000000,
					canvasMaxAreaInBytes: 64000000
				});
				pdf = await loadingTask.promise;
				if (!alive) return;
				pages = pdf.numPages;
				await render(1);
			} catch {
				if (alive) {
					error =
						'This PDF could not be opened. It may be encrypted or damaged. Download it to open in another reader.';
					busy = false;
				}
			}
		})();
		return () => {
			alive = false;
			renderTask?.cancel();
			void loadingTask?.destroy().catch(() => {});
		};
	});
</script>

<div class="pdf-controls">
	<button disabled={busy || page <= 1} onclick={() => render(page - 1)}>Previous page</button><span
		aria-live="polite">{pages ? `Page ${page} of ${pages}` : 'Loading PDF…'}</span
	><button disabled={busy || page >= pages} onclick={() => render(page + 1)}>Next page</button>
</div>
{#if error}<p role="alert">{error}</p>{/if}
<div class="pdf-page" aria-busy={busy}>
	<canvas bind:this={canvas} aria-label={`PDF page ${page}`}></canvas>
</div>

<style>
	.pdf-controls {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 18px;
		padding: 10px;
		font-size: 12px;
		border-bottom: 1px solid var(--color-line);
	}
	button {
		border: 1px solid var(--color-line);
		border-radius: 6px;
		padding: 6px 10px;
	}
	button:disabled {
		opacity: 0.4;
	}
	.pdf-page {
		min-height: 0;
		flex: 1;
		overflow: auto;
		background: #e5e7eb;
		padding: 20px;
	}
	canvas {
		display: block;
		max-width: 100%;
		height: auto;
		margin: auto;
		box-shadow: 0 2px 12px #0002;
		background: white;
	}
	p {
		padding: 20px;
		color: var(--color-danger);
	}
</style>
