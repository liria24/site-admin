# @liria24/site-admin

## What does it do?

Site Admin adds schema-driven content management to a Nuxt application: typed models, drafts and revisions, publishing, localized routes, assets, SEO and optional AI suggestions.

Build your own public pages and administration UI. Site Admin supplies public and authenticated management APIs, typed composables and headless forms. Your application owns its database connection, migrations, authentication providers and AI model.

## Install

```sh
bun add @liria24/site-admin better-auth @nuxtjs/better-auth comark
# Peers for the default Nuxt integrations (or disable unused integrations):
bun add @nuxtjs/i18n @nuxtjs/robots @nuxtjs/sitemap nuxt-llms nuxt-og-image nuxt-schema-org nuxt-seo-utils nuxt-site-config
# Optional forms, files and AI:
bun add @tanstack/vue-form@2.0.0-alpha.2 files-sdk nuxt-files-sdk ai
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

The module registers integrations installed in your app. Shared packages are peers; import public exports such as `better-auth/plugins`, `@nuxtjs/better-auth/config`, `ai` and `comark/parse` directly. Site Admin no longer creates dependency aliases or resolver plugins. Configure their native Nuxt options as needed; use `siteAdmin` switches to disable integrations you do not use. Database drivers and AI providers remain application-selected dependencies.

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
                slug: text({ default: '' }),
                title: text({ required: true }),
                excerpt: textarea({ maxLength: 180 }),
                body: markdown({ required: true }),
            },
        },
    },
})
```

Create the application helper `server/database.ts` to return your chosen Drizzle SQLite or D1 connection. The resolver runs when a request or task needs the adapter; use its `{ event, request, platformContext }` argument for request-bound connections. Your application controls caching and disposal. See the [application connection example](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/server/database.ts) and [adapter protocol](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/adapter.ts).

Management search queries accept at most 512 Unicode code points before and after lowercase mapping; longer queries return INVALID_INPUT (HTTP 400). Unicode management search keeps bounded derived-text chunks in existing metadata, leaving canonical columns and history unchanged. Cold projections use at most 24 preparation statements per request (up to 256 small heads); the management client resumes search GETs only while reported preparation progresses. Filtering, counts and pages remain in one native database snapshot, including matches across chunk boundaries. Other requests are not retried.

For example, a Node application can own a lazily opened SQLite connection:

```ts
// server/database.ts
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as schema from './database/schema'

let db: ReturnType<typeof drizzle> | undefined
export const getAppDb = () => (db ??= drizzle('./.data/content.sqlite3', { relations: schema.authRelations }))
```

Create the data directory and close the connection in your application's lifecycle. For D1, replace this helper with one that reads the current application's binding.

Configure Better Auth directly in `server/auth.config.ts`, using `defineServerAuth` from `@nuxtjs/better-auth/config` and your application-owned auth adapter. Keep its connection and generated schema consistent with the content adapter. Add `app/auth.config.ts` with the native client configuration, and set `NUXT_BETTER_AUTH_SECRET`. The [server](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/server/auth.config.ts) and [client](https://github.com/liria24/site-admin/blob/main/test/fixtures/nuxt/app/auth.config.ts) fixtures show these native configurations. Defer opening connections during schema inspection.

```sh
# Bootstrap the content schema before auth configuration imports it.
bun x site-admin generate --out server/database/schema.ts
# Then include the native Better Auth tables and plugins.
bun x site-admin generate --auth server/auth.config.ts --out server/database/schema.ts
bun x drizzle-kit generate --config drizzle.config.ts
bun x drizzle-kit migrate --config drizzle.config.ts
```

Point your application-owned `drizzle.config.ts` at that schema and your chosen migration directory/database. Review generated migrations and apply them explicitly; Site Admin never opens a built-in connection or applies migrations. For D1, apply SQL with your deployment tooling. Auth generation uses the native adapter and its provider/table options from your auth configuration; combined content schemas currently support SQLite/D1.

Saves create drafts until publication; set a model's `publishing: false` for immediate publication. Models are public by default; `public: false` removes anonymous access. Fields include relations, files, images, arrays and objects, with optional Standard Schema validation. See [model/config types](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/config.ts).

## Use it in the app

Nuxt infers model names and field types from the common configuration:

```ts
// Inside a page's <script setup>
const route = useRoute()
const entry = await useContent('posts', {
    path: () => route.path,
    default: () => null,
})
const posts = await useContent('posts', { default: () => [], lazy: true })
const summary = computed(() => entry.data.value?.data.body.meta.summary)
const batch = await useContent({
    posts: { list: 'posts' },
    featured: { entry: 'posts', path: () => route.path },
})
```

Global SEO, resolved entry metadata and common route rules apply automatically. Use native `useSeoMeta`, `useHead` and `defineOgImage` for page overrides. The `seo` and `ogImage` switches control each integration independently.

These composables return native Nuxt `AsyncData`: `data`, `error`, `status`, `refresh`, `execute` and `clear`. They accept native options such as `transform`, `pick`, `default`, `watch`, `server`, `lazy`, `dedupe` and `timeout`, plus a reactive `locale`. With `siteAdmin.i18n` enabled, an omitted locale follows the installed i18n locale; otherwise set `locale` explicitly when needed. Reactive slugs/locales update the request and SSR payload is reused during hydration.

Public and management composables keep a single native `AsyncData` subscription per key. Additional callers attach to that entry, including after a reactive slug or locale changes, so an application does not patch Nuxt for the shared-key construction race in Nuxt 4.6.1.

Public entries have typed `entry.data.value?.data.title`; Markdown fields are parsed Comark documents; see [Markdown handling](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/markdown/content.ts). A batch preserves each named model's type and exposes its own `{ data, error }`, for example `batch.data.value?.featured.data?.data.title`. A missing entry is `null`; unknown/private model names are rejected by the generated types. See [public data examples and inference checks](https://github.com/liria24/site-admin/blob/main/test/nuxt-public-data-types.test.ts).

`entry.data.value?.data.body.meta.summary` is typed as `Node[] | undefined`. An explicit native Comark summary before `<!-- more -->` wins, including an empty summary. Otherwise it contains up to two body paragraphs and 280 graphemes, excluding images, code and raw HTML. The body AST is unchanged; `markdown.summary.enabled: false` disables both. Render the AST with Comark and use CSS for the visible line limit; no AI runs.

Use `useContent('posts', { markdown: 'summary' })` or `{ list: 'posts', markdown: 'summary' }` in a batch to send rendering documents whose `nodes` contain only the summary, including nested and related Markdown. Missing summaries and `summary.enabled: false` have empty nodes, including when custom plugins provide summaries. Source, frontmatter and other Markdown plugin metadata are omitted on the server before HTTP/SSR serialization; default lists and details retain full content and separate native cache keys. This reduces payloads, not database reads or parsing.

Native transformations preserve their output type:

```ts
const titles = await useContent('posts', {
    transform: (entries) => entries.map((entry) => entry.data.title),
    default: () => [],
})
// titles.data.value is string[].
```

## Administration API

`useAdminEntries` loads a model list; `useAdminEntry` loads one entry. A reactive ID follows navigation; `null` explicitly creates a new draft resource. Both extend native AsyncData with one `status` and `error` for reads and writes.

```ts
const entry = await useAdminEntry('posts', () => props.id ?? null)
const { form, fields, draft, upload, publish, schedule } = useEntryForm(entry, {
    onSuccess: () => navigateTo('/admin/posts'),
})
form.setFieldValue('title', 'Edited')
await form.handleSubmit()
await publish()
await schedule(atISOString)
await upload('image', files)
// form.Field, form.Subscribe, form.atom and field names are native TanStack APIs.

const posts = await useAdminEntries('posts', { page: ref(1) })
const item = posts.data.value?.items[0]
if (item) await posts.remove(item)
const all = await useAdminEntries('posts', { all: true })
if (all.data.value) await all.reorder(all.data.value.items.toReversed())
```

The form's values are model data directly. Declared asset fields expose authenticated URLs and are serialized automatically. `fields` supplies UI metadata; `entry.display(values)` supplies display text and an image. Schema descriptors and serialization helpers are internal.

List actions take the entry first: `publish(entry)`, `unpublish(entry)`, `schedule(entry, at)`, `cancelSchedule(entry)`, `revisions(entry)` and `restore(entry, revisionId)`. A single resource provides `save(values)`, `publish(values?)`, `schedule(at, values?)`, `remove()`, `unpublish()`, `cancelSchedule()`, `revisions()` and `restore(revisionId)`. Management response shapes are fixed. Read items through `data.items`; there is no second items state.

`features` contains `publishing`, `scheduling`, `revisions` and `sortable`. Model publishing/revisions default to true; scheduling defaults to publishing. Publishing-disabled models save directly to the public snapshot. Scheduling cannot be enabled without publishing. Disabled operations are also rejected by the server.

`revisions: false` atomically removes obsolete revisions and derived references on each mutation, retaining current, public, scheduled and required route snapshots. Existing databases need an explicit application migration to cancel disabled schedules and delete obsolete history; runtime startup never performs bulk migrations.

Mutations serialize writes, deduplicate identical concurrent requests and never retry automatically. Error data contains `code`, optional `issues` and `committed: true` if a write succeeded but refresh/navigation failed. Dirty refreshes retain local input and report conflicts. Reordering is optimistic and rolls back on failure; pass proposed orders without mutating resource data first.

`draft.isDirty`, `snapshot()`, `isStale(snapshot)` and `discard()` support proposal approval and session restoration. Clean drafts clear automatically. Actor changes clear private state and abort pending work. A new publication/schedule first persists a draft, then prepares and submits a candidate. Preparation failure retains that draft; `onSuccess` runs after the final operation.

### Application preparation

Slug is an ordinary application field. The SDK does not derive, validate or store separate slug metadata. Generic route parameters read model fields: `/posts/:slug` reads `data.slug`, `/products/:code` reads `data.code`, and reserved `:id` uses entry identity. `route: true` defaults to `/<model>/:id`. Parameters are encoded; missing/invalid route values fail publication. Route ownership remains atomic and old paths redirect after a URL change. Markdown/cache identities use entry IDs.

Register the client preparation hook to derive candidates according to application policy:

```ts
export default defineNuxtPlugin((nuxtApp) => {
    const admin = useAdminClient()
    nuxtApp.hook('site-admin:entry:prepare', async (context) => {
        const { model, operation, value, entry, resource, signal } = context
        if (operation === 'save') return
        // Existing or manually entered values win. Keep policy in the application.
        if (value.slug) return
        if (entry?.publishedRevisionId) throw new Error('Enter the established URL.')
        value.slug =
            model === 'posts'
                ? (
                      await admin.ai.run(
                          'publication',
                          { title: String(value.title), content: String(value.body) },
                          { signal },
                      )
                  ).slug
                : resource
                      .display(value)
                      .title.toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, '')
    })
})
```

The hook receives a candidate copy, model, entry, resource, features, operation and AbortSignal. It runs once through the shared save/publish/schedule path for browser resources, forms and imperative clients. Mutate the candidate; do not submit another mutation from inside the hook. Input changes during preparation prevent a stale candidate from being sent. Scheduling fixes the candidate at registration; the background publisher performs no AI generation.

### Imperative and server APIs

`useAdminClient()` is the browser imperative API. Server code imports `useAdmin` from `@liria24/site-admin/server` and calls `useAdmin(event?, platformContext?)`. Management operations require an event and use the same authorization boundary; trusted background tasks may supply only platform context. Database resolution is lazy, so AI actions do not open the content database.

| Namespace        | Operations                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| entries          | list, get, create, update, remove, publish, unpublish, schedule, cancelSchedule, reorder, references |
| revisions        | list, restore                                                                                        |
| assets           | upload, get, download, remove                                                                        |
| ai               | run                                                                                                  |
| content (server) | list, get, resolve                                                                                   |
| tasks (server)   | publishDue, collectAssets, syncAssets                                                                |

Imperative writes accept a fetched entry or `{ id, version }`; expected-version transport fields remain internal. Use `Entry<Model>`, `Revision<Model>`, `Content<Model>` and `Asset` for application types. Other supported exports are `defineSiteAdminConfig`, the 14 field builders, `drizzleAdapter` and their configuration/DTO types. Paths under `internal/` are implementation details, without compatibility guarantees.

Native hooks are `site-admin:config` (Nuxt build), `site-admin:database`, `site-admin:authorize` and `site-admin:entry:committed` (server), plus the client preparation hook above. Committed-hook failures are recorded after the transaction and cannot undo saved data. Define authorization inline as `authorization: { roles: { editor: { models: { posts: ['readDraft', 'update'] } } } }`; the built-in admin role cannot be overridden.

## Optional settings and reference

- **Files:** put native Files SDK `storage` and environment overrides in the common file. `assets` controls upload/publication policy. An existing `files.config.ts` takes precedence for physical storage. See [Files selection](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/nuxt/files-source.ts) and [asset policy](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/assets-config.ts).
- **AI:** each `ai.actions` entry declares `input: StandardSchema`, an application-selected model, and native `prompt`/`Output` or `state`/`questions`. `useAi(name, { input, immediate: false })` extends native fetch/AsyncData with typed data, status, error, execute, refresh and clear. POST, disabled watching and zero retries are fixed; `execute({ signal })` and `clear()` cancel. `admin.ai.run(name, input)` offers imperative execution. Sessions and role `ai: [name]` grants protect inference. Input validation runs before provider resolution; callbacks receive validated input. Use the native AI SDK directly for unrelated background AI.
- **SEO and routes:** common `seo` supplies defaults; `models.posts.seo` accepts an object or synchronous entry resolver. Top-level common `routeRules` applies `seo`, `sitemap` and `llms` rules to actual pathnames, including i18n prefixes such as `/ja/posts/**`. Metadata applies automatically, including when routing is disabled. Native page/layout head overrides remain available. See [SEO/route types](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/seo.ts).
- **OG images:** configure the native `nuxt-og-image` renderer and install its renderer dependencies in your application. Common SEO accepts a component/props/options descriptor; explicit page overrides use native `defineOgImage`.
- **Tasks:** opt in with `tasks: { publishDue: '* * * * *', syncAssets: true }`. A cron string schedules the native Nitro task; `true` allows manual runs. Your application supplies database/platform context. See [task API](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/runtime/tasks.ts).

Management defaults to `/api/site-admin/**`; public content uses `/api/content/**`. Missing sessions receive `401` and insufficient permissions `403`. Grant the first administrator its native Better Auth `admin` role through a trusted setup path; signup is not automatically elevated. Disabling `siteAdmin.auth` disables management HTTP routes.

Published-asset checks do not make a public bucket private. For private originals, explicitly enable `assets.separateDrafts` and provide a genuinely private `draft` storage. Keep draft/management responses out of shared caches.

Supported integration: Nuxt 4.6 with its default Nitro 2 builder. Check the package's Node engine requirement. For implementation details, use the [Nuxt options](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/nuxt.ts), [internal server implementation](https://github.com/liria24/site-admin/blob/main/packages/site-admin/src/server/site-admin.ts) and [test suite](https://github.com/liria24/site-admin/tree/main/test/). Contributors run `bun run check`; [CI](https://github.com/liria24/site-admin/blob/main/.github/workflows/ci.yml) also validates packed consumers and native runtimes. Releases use the existing [release workflow](https://github.com/liria24/site-admin/blob/main/.github/workflows/release.yml).
