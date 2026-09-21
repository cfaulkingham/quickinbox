<script lang="ts">
	let {
		values = $bindable<number[]>([]),
		disabled = false
	}: { values?: number[]; disabled?: boolean } = $props();
	function update(index: number, value: number) {
		values = values.map((v, i) => (i === index ? value : v));
	}
</script>

<fieldset {disabled}>
	<legend>Reminders</legend>
	{#each values as value, index}<div class="reminder-row">
			<input
				aria-label={`Reminder ${index + 1} minutes before`}
				type="number"
				min="0"
				max="10080"
				required
				{value}
				oninput={(e) => update(index, Number(e.currentTarget.value))}
			/><span>minutes before</span><button
				type="button"
				aria-label={`Remove reminder ${index + 1}`}
				onclick={() => (values = values.filter((_, i) => i !== index))}>✕</button
			>
		</div>{/each}
	{#if values.length < 5}<button
			type="button"
			onclick={() => (values = [...values, values.length ? 60 : 10])}>+ Add reminder</button
		>{/if}
	{#if !values.length}<span class="subtle">No reminders</span>{/if}
</fieldset>

<style>
	fieldset {
		display: grid;
		gap: 8px;
		border: 0;
		padding: 0;
		min-width: 0;
	}
	legend {
		font-size: 12px;
		margin-bottom: 8px;
	}
	.reminder-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.reminder-row input {
		max-width: 110px;
	}
	fieldset > button {
		justify-self: start;
	}
</style>
