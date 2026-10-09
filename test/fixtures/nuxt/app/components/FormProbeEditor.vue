<script setup lang="ts">
const props = defineProps<{ id?: string }>()
const editor = await useSiteAdminForm('posts', { id: () => props.id, locale: 'en' })
const version = editor.baseVersion
const entryId = editor.entryId
</script>

<template>
    <div>
        <span id="form-title">{{ editor.form.state.values.title }}</span>
        <span id="form-id">{{ entryId ?? 'new' }}</span>
        <span id="form-version">{{ version ?? 'new' }}</span>
    </div>
</template>
