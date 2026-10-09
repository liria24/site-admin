# @liria24/site-admin

## What does it do?

Site Admin adds schema-driven content management to a Nuxt application: typed models, drafts and revisions, publishing, localized routes, assets, SEO and optional AI suggestions.

Build your own public pages and administration UI. Site Admin supplies public and authenticated management APIs, typed composables and headless forms. Your application owns its database connection, migrations, authentication providers and AI model.

## Install

```sh
bun add @liria24/site-admin
# For the application-owned Drizzle example and schema generation below:
bun add drizzle-orm@1.0.0-rc.4 @better-auth/drizzle-adapter
bun add -D drizzle-kit@1.0.0-rc.4
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@liria24/site-admin/nuxt'],
    site: { name: 'Example', url: 'https://example.com' },
    i18n: { defaultLocale: 'en', locales: ['en'] },
    llms: { domain: 'https://example.com', title: 'Example' },
})
```

The module installs its integrations. Configure their native Nuxt options as needed; use `siteAdmin` switches to disable integrations you do not use. Database drivers and AI providers remain application-selected dependencies.

## Define content

Keep models and server configuration together in `site-admin.config.ts`:

```ts
import { defineSiteAdminConfig, markdown, text, textarea } from '@liria24/site-admin'
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'

export default defineSiteAdminConfig({
    database: async () => {
        const [{ getAppDb }, schema] = await Promise.all([
            import('./server/database'),
            import('./server/database/schema'),
        ])
        return drizzleAdapter(await getAppDb(), { schema })
    },
    seo: { titleTemplate: '%s | Example' },
    models: {
        posts: {
            route: '/posts/:slug',
            displayFields: { title: 'title', description: 'excerpt' },
            fields: {
                title: text({ required: true }),
                excerpt: textarea({ maxLength: 180 }),
                body: markdown({ required: true }),
            },
        },
    },
})
```

Create the application helper `server/database.ts` to return your chosen Drizzle SQLite or D1 connection. The resolver runs when a request or task needs the adapter; use its `{ event, request, platformContext }` argument for request-bound connections. Your application controls caching and disposal. See the [application connection example](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/server/database.ts) and [adapter protocol](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/adapter.ts).

Unicode management search keeps derived text in existing metadata, leaving canonical columns and history unchanged. Old projections populate at most 384 heads per request; larger cold searches return 503 and resume on retry. Filtering, counts and pages remain in one native database snapshot.

For example, a Node application can own a lazily opened SQLite connection:

```ts
// server/database.ts
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as schema from './database/schema'

let db: ReturnType<typeof drizzle> | undefined
export const getAppDb = () => (db ??= drizzle('./.data/content.sqlite3', { relations: schema.authRelations }))
```

Create the data directory and close the connection in your application's lifecycle. For D1, replace this helper with one that reads the current application's binding.

Configure Better Auth directly in `server/auth.config.ts`, using `defineServerAuth` from `#nuxtjs/better-auth/config` and your application-owned auth adapter. Keep its connection and generated schema consistent with the content adapter. Add `app/auth.config.ts` with the native client configuration, and set `NUXT_BETTER_AUTH_SECRET`. The [server](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/server/auth.config.ts) and [client](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/app/auth.config.ts) fixtures show these native configurations. Defer opening connections during schema inspection.

```sh
# Bootstrap the content schema before auth configuration imports it.
bun x site-admin generate --out server/database/schema.ts
# Then include the native Better Auth tables and plugins.
bun x site-admin generate --auth server/auth.config.ts --out server/database/schema.ts
bun x drizzle-kit generate --config drizzle.config.ts
bun x drizzle-kit migrate --config drizzle.config.ts
```

Point your application-owned `drizzle.config.ts` at that schema and your chosen migration directory/database. Review generated migrations and apply them explicitly; Site Admin never opens a built-in connection or applies migrations. For D1, apply SQL with your deployment tooling. Use `--auth-use-plural` only when the native auth adapter uses plural table names.

Saves create drafts until publication; set a model's `publishing: false` for immediate publication. Models are public by default; `public: false` removes anonymous access. Fields include relations, files, images, arrays and objects, with optional Standard Schema validation. See [model/config types](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/config.ts).

## Use it in the app

Nuxt infers model names and field types from the common configuration:

```ts
// Inside a page's <script setup>
const route = useRoute()
const entry = await useSiteAdminEntry('posts', () => String(route.params.slug), {
    default: () => null,
})
const posts = await useSiteAdminList('posts', { default: () => [], lazy: true })
const summary = computed(() => entry.data.value?.data.body.meta.summary)
const batch = await useSiteAdminBatch({
    posts: { list: 'posts' },
    featured: { entry: 'posts', slugOrId: () => String(route.params.slug) },
})
useSeo(() => entry.data.value?.seo)
```

Pages using explicit `useSeo()` can set `siteAdmin.routing.metadata: false` in `nuxt.config.ts` to disable automatic route metadata while retaining routing and the SEO helpers.

These composables return native Nuxt `AsyncData`: `data`, `error`, `status`, `refresh`, `execute` and `clear`. They accept native options such as `transform`, `pick`, `default`, `watch`, `server`, `lazy`, `dedupe` and `timeout`, plus a reactive `locale`. With `siteAdmin.i18n` enabled, an omitted locale follows the installed i18n locale; otherwise set `locale` explicitly when needed. Reactive slugs/locales update the request and SSR payload is reused during hydration.

Nuxt 4.6.0 with Vue 3.6.0-rc.9/rc.10 needs the explicit application-owned [temporary compatibility patch](https://github.com/liria24/site-admin/blob/main/patches/nuxt%404.6.0.patch) for shared reactive keys. Site Admin does not apply it to consumers. Remove it after an upstream compatible release passes the [same native regression](https://github.com/liria24/site-admin/blob/main/test/nuxt-native-reentrancy.test.ts) and browser checks.

Public entries have typed `entry.data.value?.data.title`; Markdown fields are parsed Comark documents; see [Markdown handling](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/markdown/content.ts). A batch preserves each named model's type and exposes its own `{ data, error }`, for example `batch.data.value?.featured.data?.data.title`. A missing entry is `null`; unknown/private model names are rejected by the generated types. See [public data examples and inference checks](https://github.com/liria24/site-admin/blob/main/test/nuxt-public-data-types.test.ts).

`entry.data.value?.data.body.meta.summary` is typed as `Node[] | undefined`. An explicit native Comark summary before `<!-- more -->` wins, including an empty summary. Otherwise it contains up to two body paragraphs and 280 graphemes, excluding images, code and raw HTML. The body AST is unchanged; `markdown.summary.enabled: false` disables both. Render the AST with Comark and use CSS for the visible line limit; no AI runs.

Use `useSiteAdminList('posts', { markdown: 'summary' })` or `{ list: 'posts', markdown: 'summary' }` in a batch to send rendering documents whose `nodes` contain only the summary, including nested and related Markdown. Missing summaries and `summary.enabled: false` have empty nodes, including when custom plugins provide summaries. Source, frontmatter and other Markdown plugin metadata are omitted on the server before HTTP/SSR serialization; default lists and details retain full content and separate native cache keys. This reduces payloads, not database reads or parsing.

Native transformations preserve their output type:

```ts
const titles = await useSiteAdminList('posts', {
    transform: (entries) => entries.map((entry) => entry.data.title),
    default: () => [],
})
// titles.data.value is string[].
```

For editing, use the typed management client:

```ts
const management = useSiteAdminManagementClient()
const entries = await management.listAllEntries('posts')
```

Management APIs cover drafts, revisions, publishing, scheduling, ordering, assets and AI proposals. Pass the current `expectedVersion` for direct client edits and publication. Install the optional `@tanstack/vue-form` peer and await the model form during component setup:

```ts
const create = await useSiteAdminForm('posts', {})
const editor = await useSiteAdminForm('posts', { id: () => props.id })
const list = await useSiteAdminManagementList('posts') // locale is explicit for management
await editor.form.handleSubmit() // save a draft, without AI
// After any app-selected action and explicit apply:
await editor.publish() // atomically stores and publishes the current candidate
// Or: await editor.schedule(atISOString)
// editor.form fields and list.data.value?.items infer the selected model.
// Assets expose field.value.url / item.data.image.url / uploaded.url.
```

The form loads its descriptor and entry, retains session drafts, tracks `dirty` and `baseVersion`, and saves with optimistic concurrency. Draft saves never invoke AI. Empty draft slugs use an internal placeholder and require a final slug before publication. Use application-owned `ai.models[model][action]` with `editor.ai.run(action, input)`, then explicitly `apply({ fields, slug })` or discard. Prompts, output schemas, metadata generation and proofreading policies belong to your application. `ai.proposal`, `busy`, `error` and `stale` support explicit `ai.apply()` / `discard()` without saving; no proposal is implicitly applied. A dirty refresh preserves edits and reports version conflicts. Drafts are isolated by connection, actor, model, locale and ID; use `key` to separate simultaneous new entries. Layout, editor rendering, toasts and navigation remain application-owned. The `{ entry }` and Core descriptor overloads remain available; see the [headless form API](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/form.ts).

Direct `publishEntry` and `schedulePublish` accept either `revisionId` or an optional `draft: { data, slug }`, with `expectedVersion`; candidates require update permission as well as publish/schedule permission. Revision, route and version writes are atomic. `draft.serialize()` returns a typed raw snapshot and its base version. A new form must first save its draft to establish an ID before an entry action, publication or scheduling.

Successful Nuxt management-client mutations clear and refresh affected model lists, entry data and dependent batches through native Nuxt APIs. Refresh failures do not undo a successful save. Nuxt's public key enumeration covers serialized payload data; `serialize: false` reads need explicit refresh, and an application-owned `getCachedData` or extracted static cache must invalidate its own cache. Native options and manual `refresh` remain available. Display URLs use the authenticated asset route and are stripped from schema-declared asset values on save; they do not grant public access.

## Optional settings and reference

- **Files:** put native Files SDK `storage` and environment overrides in the common file. `assets` controls upload/publication policy. An existing `files.config.ts` takes precedence for physical storage. See [Files selection](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/nuxt/files-source.ts) and [asset policy](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/assets-config.ts).
- **AI:** `ai.actions` defines schema-backed `props`, per-action/shared models, and native text-generation `prompt`/`Output` or decision `state`/`questions`. `useAiAction(name, { props, immediate: false })` and server `runAiAction(event, name, { props })` infer input/output. Sessions and role `ai: [name]` permissions protect execution. Native Nuxt `createUseFetch` owns SSR/hydration and status/error: POST, `watch: false`, zero retries; `execute()` reports failure in `error`, and `execute({ signal })` / `clear()` cancel. `server: false` cannot await client data during setup. Output factories receive validated input for app-owned preservation/DB guards. Providers, applying results and version-checked saves belong to your app. AI-free config omits the capability. One-off `createSiteAdminAI(model, context).generateText()` stays native; legacy `ai.models` uses explicit Core `aiExecution` injection, automatic in Nuxt. See [AI types](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/ai.ts).
- **SEO and routes:** common `seo` supplies defaults; `models.posts.seo` accepts an object or synchronous entry resolver. Top-level common `routeRules` applies `seo`, `sitemap` and `llms` rules to actual pathnames, including i18n prefixes such as `/ja/posts/**`. `useSeo()` applies reactive entry metadata and optional page overrides. See [SEO/route types](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/seo.ts).
- **OG images:** configure the native `nuxt-og-image` renderer and install its renderer dependencies in your application. `useSeo()` accepts its component/props/options descriptor when that integration is enabled.
- **Tasks:** opt in with `tasks: { publishDue: '* * * * *', syncAssets: true }`. A cron string schedules the native Nitro task; `true` allows manual runs. Your application supplies database/platform context. See [task API](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/runtime/tasks.ts).
- **Owned imports:** use the seven `#better-auth`, `#nuxtjs/better-auth`, `#nuxt-files-sdk`, `#files-sdk`, `#comark`, `#comark-content` and `#ai` namespaces for their [24 supported entrypoints](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/dependency-aliases.ts). They work after module setup and in the schema CLI; use ordinary imports in `nuxt.config.ts`. Standalone runners can opt into the exported dependency plugin/type paths. Jiti configuration aliases retain Jiti's prefix semantics.

Management defaults to `/api/site-admin/**`; public content uses `/api/content/**`. Missing sessions receive `401` and insufficient permissions `403`. Grant the first administrator its native Better Auth `admin` role through a trusted setup path; signup is not automatically elevated. Disabling `siteAdmin.auth` disables management HTTP routes.

Published-asset checks do not make a public bucket private. For private originals, explicitly enable `assets.separateDrafts` and provide a genuinely private `draft` storage. Keep draft/management responses out of shared caches.

Supported integration: Nuxt 4.6 with its default Nitro 2 builder. Check the package's Node engine requirement. For implementation details, use the [Nuxt options](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/nuxt.ts), [core server API](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/server/site-admin.ts) and [test suite](https://github.com/liria24/site-admin/tree/main/test/). Contributors run `bun run check`; [CI](https://github.com/liria24/site-admin/blob/main/.github/workflows/ci.yml) also validates packed consumers and native runtimes. Releases use the existing [release workflow](https://github.com/liria24/site-admin/blob/main/.github/workflows/release.yml).
