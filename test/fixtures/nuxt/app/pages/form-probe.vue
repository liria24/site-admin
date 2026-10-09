<script setup lang="ts">
const route = useRoute()
const id = computed(() => (typeof route.query.id === 'string' ? route.query.id : undefined))
</script>

<template>
    <FormProbeEditor :id="id" />
</template>
