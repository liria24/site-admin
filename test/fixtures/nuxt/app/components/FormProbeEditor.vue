<script setup lang="ts">
const props = defineProps<{ id?: string }>()
const resource = await useAdminEntry('posts', () => props.id ?? null, { locale: 'en' })
const { form } = useEntryForm(resource)
const version = computed(() => resource.data.value?.version)
const entryId = computed(() => resource.data.value?.id)
</script>
<template>
    <div>
        <span id="form-title">{{ form.state.values.title }}</span>
        <span id="form-id">{{ entryId ?? 'new' }}</span>
        <span id="form-version">{{ version ?? 'new' }}</span>
    </div>
</template>
