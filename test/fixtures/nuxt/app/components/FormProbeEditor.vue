<script setup lang="ts">
const props = defineProps<{ id?: string }>()
const { data, form } = await useAdminForm('posts', { id: () => props.id, locale: 'en' })
const version = computed(() => data.value?.version)
const entryId = computed(() => data.value?.id)
</script>
<template>
    <div>
        <span id="form-title">{{ form.state.values.title }}</span>
        <span id="form-id">{{ entryId ?? 'new' }}</span>
        <span id="form-version">{{ version ?? 'new' }}</span>
    </div>
</template>
