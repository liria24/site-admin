<script setup lang="ts">
const { data } = await useAdminEntries('posts', { locale: 'en' })
</script>

<template>
    <ul>
        <li v-for="item in data?.items" :key="item.id" data-admin-entry>{{ item.data.title }}</li>
    </ul>
</template>
