<script lang="ts">
	import ChatWorkspace from '$lib/chat/ChatWorkspace.svelte';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Chat · Quickinbox</title></svelte:head>
{#key data.user?.id}<ChatWorkspace
		userId={data.user!.id}
		callsEnabled={data.callsEnabled}
	/>{/key}
