# @liria24/site-admin

Typed content, publishing, Assets and headless administration forms for Nuxt. Your app owns its UI, database lifecycle, authentication providers and AI policy.

## Start

```sh
bun add @liria24/site-admin
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@liria24/site-admin/nuxt'],
    site: { name: 'Example', url: 'https://example.com' },
    i18n: { defaultLocale: 'ja', locales: ['ja', 'en'], strategy: 'prefix_except_default' },
    siteAdmin: { ogImage: false, llms: false },
})
```

Disable unused integrations with `siteAdmin.auth`, `ai`, `i18n`, `markdown`, `seo`, `sitemap`, `robots`, `schemaOrg`, `ogImage` or `llms`. Use native `files: false` to disable Files.

## Models and database

```ts
// site-admin.config.ts
import { defineSiteAdminConfig, datetime, image, markdown, text } from '@liria24/site-admin'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'

export default defineSiteAdminConfig({
    storage: { adapter: 'fs', config: { root: '.data/files' } },
    assets: {},
    database: async ({ event, platformContext }) => {
        const [{ getAppDb }, schema] = await Promise.all([
            import('./server/database'),
            import('./server/database/schema'),
        ])
        return drizzleAdapter(await getAppDb(event, platformContext), { schema })
    },
    models: {
        posts: {
            route: '/posts/:slug',
            displayFields: { title: 'title', description: 'body', image: 'image' },
            fields: {
                slug: text({ i18n: true }),
                title: text({ required: true, i18n: true }),
                body: markdown({ required: true, i18n: true }),
                image: image(),
                createdAt: datetime(),
            },
        },
        links: {
            publishing: false,
            scheduling: false,
            revisions: false,
            fields: { title: text({ required: true }) },
        },
    },
    routeRules: { '/admin/**': { seo: { title: 'Admin', robots: 'noindex' } } },
})
```

Choose and install your Drizzle SQLite/D1 driver and AI provider. `getAppDb` returns an application-owned connection; the SDK reuses its adapter for the same native connection and schema. Configure authentication with native Better Auth server/client config and an application-owned auth adapter.

```sh
bun x site-admin generate --out server/database/schema.ts
bun x site-admin generate --auth server/auth.config.ts --out server/database/schema.ts
bun x drizzle-kit generate --config drizzle.config.ts
```

Apply SQL migrations explicitly. After migrating existing content or changing searchable fields, run `await useAdmin().tasks.rebuildSearch()` in your migration/startup procedure. HTTP reads and production builds never migrate or rebuild search.

## Read content

```ts
const { data: posts } = await useContent('posts')
const { data: post } = await useContent('posts', { id: postId })
const { data: cards } = await useContent('posts', { markdown: 'summary' })
const offset = ref(0)
const { data: page } = await useContent('posts', {
    page: () => ({ limit: 20, offset: offset.value }),
    markdown: 'summary',
})
// page.value: { items, total, limit, offset }
```

Native AsyncData options, transforms and errors work as usual. Locale resolves from an explicit option, the current Nuxt i18n locale, then the article's original. Missing translations and fields inherit the original. Entry routes, configured route SEO and translated parameters are applied automatically.

## Edit content

```vue
<script setup lang="ts">
const entry = await useAdminEntry('posts', postId) // null creates a new entry
const { form, draft, publish, schedule, upload, operation } = useEntryForm(entry, {
    onBeforeSubmit: ({ operation }) => {
        if (operation !== 'save' && reviewNeeded.value) throw new Error('Review the suggestion first.')
    },
    onUpload: ({ files }) => {
        lastFilename.value = files[0]?.name ?? ''
    },
    onSuccess: () => navigateTo('/admin/posts'),
})
const reviewNeeded = ref(false)
const lastFilename = ref('')
// await draft.ensure() quietly creates/reuses a draft for application-owned actions.
// await publish(); await schedule(new Date(...)); await upload('image', files)
</script>

<template>
    <form @submit.prevent="form.handleSubmit">
        <form.Field name="title" v-slot="{ field }">
            <input :value="field.value" @input="field.handleChange($event.target.value)" />
        </form.Field>
        <form.Subscribe :selector="(state) => ({ saving: state.isSubmitting })" v-slot="{ saving }">
            <button :disabled="saving">Save</button>
        </form.Subscribe>
    </form>
</template>
```

`entry.error` covers loading and operations. `operation` is `save | publish | schedule | upload | null`; `draft.isDirty` supports leave protection. Failed UI operations finish with a shared error; imperative client operations throw. A committed error carries its saved ID/version and pending effects: retry `syncAssets`, without resending the save.

For lists: `const { data, page, error, remove, publish } = await useAdminEntries('posts')`.

## Translations and preparation

All entries have a locale when i18n is enabled. An article's original language is fixed at creation. Fields marked `i18n: true` accept sparse per-language overrides; other fields are shared. A revision contains the original and all translations.

```ts
const admin = useAdminClient() // server: useAdmin(event)
const post = await admin.entries.create('posts', {
    defaultLocale: 'ja',
    data: { slug: 'hello', title: 'こんにちは', body: '日本語' },
    translations: { en: { title: 'Hello', body: 'English' } },
})
await admin.entries.update(
    'posts',
    { id: post.id, version: post.version },
    {
        translations: { en: { title: 'Updated' } }, // replace this sparse override
    },
)
// translations: { en: null } deletes the translation.
await admin.entries.publish('posts', { id, version })
await admin.revisions.restore('posts', { id, version }, revisionId)
```

Keep slug generation and AI review policy in your app. Preparation runs before a snapshot is saved or published; publishing and scheduling prepare the original and existing translations together.

```ts
// app/plugins/entry-policy.ts
export default defineNuxtPlugin((nuxtApp) => {
    nuxtApp.hook('site-admin:entry:prepare', ({ operation, value }) => {
        if (operation !== 'save' && !value.slug)
            value.slug = String(value.title).trim().toLowerCase().replace(/\s+/g, '-')
    })
})
```

## Integration guides

[Nuxt](https://nuxt.com/docs) · [Drizzle](https://orm.drizzle.team/docs/overview) · [Better Auth](https://www.better-auth.com/docs/introduction) · [Nuxt Better Auth](https://better-auth.nuxt.dev/) · [Nuxt i18n](https://i18n.nuxtjs.org/docs/guide/custom-paths/) · [TanStack Form](https://tanstack.com/form/latest/docs/framework/vue/overview) · [Comark](https://comark.dev/) · [Files SDK](https://files-sdk.dev/) · [AI SDK](https://ai-sdk.dev/docs/introduction) · [Nuxt SEO](https://nuxtseo.com/docs)
