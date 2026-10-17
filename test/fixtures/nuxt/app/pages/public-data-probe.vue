<script setup lang="ts">
const entry = await useContent('posts', {
    path: '/ja/posts/%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF',
    locale: 'ja',
    default: () => null,
})
const list = await useContent('posts', { locale: 'ja', default: () => [] })
const title = await useContent('posts', {
    path: '/posts/hello',
    locale: 'en',
    transform: (value) => value?.data.title ?? 'missing',
    default: () => 'pending',
})
const missing = await useContent('posts', { id: 'missing', locale: 'en', default: () => null })
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
