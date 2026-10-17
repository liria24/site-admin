<script setup lang="ts">
const { data, status, error } = await useAi('proofread', { input: { content: 'SSR input' } })
const content: string | undefined = data.value?.content
void content
</script>
<template>
    <div>
        <span id="ai-content">{{ data?.content }}</span
        ><span id="ai-status">{{ status }}</span
        ><span id="ai-error">{{ error?.statusCode }}</span>
    </div>
</template>
