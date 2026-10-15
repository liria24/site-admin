<script setup lang="ts">
const list = await useContent('posts', { locale: 'en', markdown: 'summary' })
const batch = await useContent({ posts: { list: 'posts', markdown: 'summary' } }, { locale: 'en' })
const listData = list.data
const batchData = batch.data
</script>

<template>
    <div>
        <span id="summary-nodes">{{ JSON.stringify(listData?.[0]?.data.body?.nodes) }}</span>
        <span id="summary-batch-nodes">{{ JSON.stringify(batchData?.posts.data[0]?.data.body?.nodes) }}</span>
    </div>
</template>
