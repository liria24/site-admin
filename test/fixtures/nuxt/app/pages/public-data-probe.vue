<script setup lang="ts">
const entry = await useSiteAdminEntry('posts', 'こんにちは', { locale: 'ja', default: () => null })
const list = await useSiteAdminList('posts', { locale: 'ja', default: () => [] })
const title = await useSiteAdminEntry('posts', 'hello', {
    locale: 'en',
    transform: (value) => value?.data.title ?? 'missing',
    default: () => 'pending',
})
const missing = await useSiteAdminEntry('posts', 'missing', { locale: 'en', default: () => null })
const entryData = entry.data
const listData = list.data
const titleData = title.data
const missingData = missing.data
</script>

<template>
    <div>
        <span id="entry-title">{{ entryData?.data.title }}</span>
        <span id="list-size">{{ listData.length }}</span>
        <span id="transformed-title">{{ titleData }}</span>
        <span id="missing-entry">{{ missingData === null }}</span>
    </div>
</template>
