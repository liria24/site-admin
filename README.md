# @liria24/site-admin

Typed content, publishing, translations and headless forms for Nuxt. Site Admin uses Void for D1 and object storage; your app supplies its UI, authentication providers and editorial policy.

## Start

```sh
bun add @liria24/site-admin void
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@liria24/site-admin/nuxt'],
    site: { name: 'Example', url: 'https://example.com' },
    i18n: { defaultLocale: 'ja', locales: ['ja', 'en'], strategy: 'prefix_except_default' },
    routeRules: { '/admin/**': { auth: { user: { role: 'admin' } } } },
    siteAdmin: { ai: false, ogImage: false, llms: false },
})
```

```ts
// void.config.ts
import { defineConfig } from 'void/config'
export default defineConfig({
    inference: { bindings: { db: true, storage: true } },
    cloudflare: { name: 'example', compatibility_flags: ['nodejs_compat'] },
})
```

Disable unused integrations with `siteAdmin.auth`, `ai`, `i18n`, `markdown`, `seo`, `sitemap`, `robots`, `schemaOrg`, `ogImage` or `llms`. Use native `files: false` to disable Files.

## Models

```ts
// site-admin.config.ts
import { defineSiteAdminConfig, image, markdown, text } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    assets: {},
    tasks: { publishDue: '* * * * *', rebuildSearch: true },
    models: {
        posts: {
            meta: ({ t }) => ({ label: t('models.post'), plural: t('models.posts'), icon: 'book' }),
            route: '/posts/:slug',
            displayFields: { title: 'title', description: 'body', image: 'image' },
            fields: {
                slug: text({ i18n: true }),
                title: text({ required: true, i18n: true, label: ({ t }) => t('fields.title') }),
                body: markdown({ required: true, i18n: true }),
                image: image(),
            },
        },
        links: {
            meta: { label: 'Link', plural: 'Links' },
            publishing: false,
            scheduling: false,
            revisions: false,
            fields: { title: text({ required: true }) },
        },
    },
    routeRules: { '/admin/**': { seo: { title: 'Admin', robots: 'noindex' } } },
})
```

Labels and SEO accept strings or synchronous `({ t, locale }) => value` resolvers. `t` uses Nuxt i18n messages; configuration is evaluated on the server. Configured route SEO applies automatically.

```ts
// server/auth.config.ts — configure providers here with native Better Auth options
import { defineServerAuth } from '@nuxtjs/better-auth/config'
export default defineServerAuth({ appName: 'Example' })
```

```sh
bun x site-admin generate       # CMS + Better Auth → db/schema.ts; no DB connection
bun x void db generate          # Review and commit db/migrations/
bun run dev                    # Void applies local migrations
bun x void deploy --platform cloudflare
```

Void owns connections and migrations. Server-side application queries use `db` from `void/db` and tables from `@schema`. The SDK initially supports D1/SQLite only. Deployment applies reviewed SQL; back up and migrate existing data before adopting a new baseline. Builds and HTTP reads never migrate. `tasks.rebuildSearch: true` rebuilds local indexes at development startup; after a remote data migration, explicitly run `useAdmin().tasks.rebuildSearch()` in that migration's server context.

## Read

```ts
const { data: posts } = await useContent('posts')
const { data: post } = await useContent('posts', { id: postId })
const offset = ref(0)
const { data: page } = await useContent('posts', {
    page: () => ({ limit: 20, offset: offset.value }),
    markdown: 'summary',
})
// page.value: { items, total, limit, offset }
```

Native AsyncData options, transforms, status and errors are supported. Locale resolves from an explicit option, Nuxt i18n, then the article's original. Missing translations and fields inherit the original; fallback pages keep the original canonical.

## Edit

```vue
<script setup lang="ts">
const route = useRoute()
const pendingReview = ref(false)
const uploadedName = ref('')
const { form, data, meta, error, operation, draft, publish, schedule, upload } = await useAdminForm('posts', {
    id: () => route.params.id as string | undefined, // omit for a new entry
    onBeforeSubmit: ({ operation }) => {
        if (operation !== 'save' && pendingReview.value) throw new Error('Review the suggestion first.')
    },
    onUpload: ({ files }) => {
        uploadedName.value = files[0]?.name ?? ''
    },
    onSuccess: () => navigateTo('/admin/posts'),
})
</script>

<template>
    <form @submit.prevent="form.handleSubmit()">
        <form.Field name="title" v-slot="{ field }">
            <input :value="field.state.value" @input="field.handleChange($event.target.value)" />
        </form.Field>
        <button type="submit">Save draft</button>
        <button type="button" @click="publish()">Publish</button>
    </form>
</template>
```

`upload(field, files)` updates the field and returns uploaded assets. `schedule(date)` accepts a `Date` or date string. `draft.ensure()` persists a draft without firing `onSuccess`. Hooks share `error`; `operation` is `save | publish | schedule | upload | null`. Unsaved input and active operations enable `beforeunload`; use `beforeUnload: () => otherWorkIsRunning.value` to include app work, or `false` to opt out.

```ts
// app/plugins/prepare-content.ts — application-owned slug policy
export default defineNuxtPlugin((app) => {
    app.hook('site-admin:entry:prepare', async (context) => {
        if (context.operation === 'save' || context.model !== 'posts') return
        context.value.slug ||= String(context.value.title)
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-|-$/g, '')
    })
})
```

A committed write remains committed if asset synchronization fails: its receipt updates the ID/version and the common error exposes the pending effect. Retry `useAdmin().tasks.syncAssets()`; do not resend the save. Imperative APIs throw failures; form resources retain input and report `error`.

## Translations and imperative operations

```ts
const admin = useAdminClient() // server: useAdmin(event)
let post = await admin.entries.create('posts', {
    defaultLocale: 'ja',
    data: { slug: 'hello', title: 'こんにちは', body: '日本語本文' },
    translations: { en: { title: 'Hello', body: 'English content' } },
})
post = await admin.entries.update(
    'posts',
    { id: post.id, version: post.version },
    {
        translations: { en: { title: 'Updated' } },
    },
)
await admin.entries.publish('posts', { id: post.id, version: post.version })
```

Each locale supplied in an update replaces its sparse overrides; omitted fields inherit the original, omitted locales stay unchanged, and `null` removes a translation. Shared fields stay in `data`. Original and translations share one version/revision and publish, schedule and restore together. Forms retain unsaved input per locale without storing untouched fallback values.

## Guides

[Void](https://void.cloud/integrations/frameworks/nuxt) · [Nuxt Better Auth](https://better-auth.nuxt.dev/) · [Better Auth](https://www.better-auth.com/docs) · [Nuxt i18n](https://i18n.nuxtjs.org/) · [Files SDK](https://files-sdk.dev/) · [Comark](https://comark.dev/) · [AI SDK](https://ai-sdk.dev/docs) · [Nuxt SEO](https://nuxtseo.com/)
