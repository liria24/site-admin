# @liria24/site-admin

Runtime-first, schema-driven site administration for Nuxt 4 and Nitro 2. It provides the content domain and APIs; it does not provide an admin UI or page builder.

Version `0.0.0` is the initial development version. The first Uppt release PR advances it to `0.0.1`.

## Requirements

- Node.js 24 or newer
- Nuxt 4 / Nitro 2
- SQLite through `node:sqlite`, or Cloudflare D1
- Vue 3.6 and `@tanstack/vue-form` 2.0.0-alpha.2 only when using `/form`

## Install

```sh
bun add @liria24/site-admin
```

Add the Nuxt module:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@liria24/site-admin/nuxt'],

    site: {
        name: 'Example',
        url: 'https://example.com',
    },

    siteAdmin: {
        database: {
            connector: 'node-sqlite',
            path: '.data/site-admin.sqlite3',
        },
        auth: { enabled: true },
    },
})
```

Define the domain separately from framework configuration:

```ts
// site-admin.config.ts
import { defineSiteAdminConfig, image, markdown, model, relation, text, url } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    models: {
        authors: model({
            fields: { name: text({ required: true }) },
        }),
        posts: model({
            route: true,
            fields: {
                author: relation('authors', { required: true }),
                body: markdown(),
                cover: image(),
                title: text({ required: true }),
            },
        }),
        socials: model({
            route: { path: '/:slug', redirect: 'url' },
            fields: { name: text(), url: url() },
        }),
    },
})
```

The field DSL also includes `textarea`, `number`, `boolean`, `datetime`, `select`, `object`, `array`, `file`, and `images`. Standard Schema validators can be attached to fields or whole models. Server validation is authoritative; browser descriptors only disclose safe capability metadata.

## Authentication

Management HTTP routes are registered only when `siteAdmin.auth.enabled` is true, and every request must receive an actor from the Nitro hook:

```ts
// server/plugins/site-admin-auth.ts
export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook('site-admin:authorize', async (context) => {
        const session = await readYourExistingSession(context.request)
        if (session) context.actor = { id: session.user.id, roles: session.user.roles }
    })
})
```

No hook result means `401`. Setting `auth.enabled: false` removes the management HTTP routes; it never makes them anonymous. Trusted server code can call `useSiteAdmin()` directly.

## Publishing and content

Every write creates an immutable revision. Models default to drafts plus explicit publish. `publishing: false` still creates revisions but advances the public pointer in the same atomic mutation.

`route` controls whether an entry owns a URL, not whether its data is public. A route-less model remains available through its published projection. Set `public: false` to exclude a model, its routes, relations, and assets from anonymous reads.

```ts
const siteAdmin = useSiteAdmin()

const draft = await siteAdmin.createEntry('posts', {
    actorId: user.id,
    data: { author: authorId, body: '# Hello', title: 'Hello' },
})

await siteAdmin.publishEntry(draft.id, {
    actorId: user.id,
    expectedVersion: draft.version,
})
```

Writes use optimistic versions. SQLite uses `BEGIN IMMEDIATE`; D1 uses one native `batch()`. There is no sequential fallback. Revision data, relation and asset indexes, routes, public pointers, and the public generation are guarded together.

Required relations must point to public, published entries. Optional unpublished relations project as `null`. Relations resolve the target entry's current published revision; publication does not snapshot the whole relation graph.

Public changes advance a site-level generation used to refresh Comark Content and route caches. Draft saves do not. HTML and CDN invalidation remain application/platform policy, so configure Nuxt `routeRules` for the freshness the site actually allows. Never share-cache management or preview responses.

## HTTP routes

The defaults are:

- Public content: `/api/content/**`
- Management: `/api/site-admin/**`
- Generated sitemap source: `/api/content/_sitemap`
- Published asset delivery: `/api/content/_assets/:id`
- LLM indexes: `/llms.txt` and `/llms-full.txt`
- Safe development diagnostics, only with Nuxt DevTools enabled: `/_site-admin/diagnostics`

Management operations cover entry CRUD, revision lists, publish/unpublish, schedule/cancel, sorting, upload/download/delete, `publish-due`, asset GC, and diagnostics. `handlePublicRequest()` and `handleManagementRequest()` are also exported for non-Nuxt HTTP composition.

Scheduling only records intent. Call `publishDue()` or POST `/api/site-admin/tasks/publish-due` from a Nitro Task or platform scheduler. Site Admin does not register a cron job.

## Assets

Assets require `nuxt-files-sdk` and a named Files storage:

```ts
// files.config.ts
import { defineFilesConfig } from 'nuxt-files-sdk/config'
import { validation } from 'nuxt-files-sdk/plugins'

export default defineFilesConfig({
    storage: {
        content: {
            adapter: 'fs',
            root: '.data/files/content',
            plugins: [validation({ maxSize: 10_000_000 })],
        },
    },
})
```

```ts
// site-admin.config.ts
export default defineSiteAdminConfig({
    assets: {
        storage: 'content',
        maxUploadSize: 10_000_000,
        orphanGracePeriod: '24h',
    },
    models: {/* ... */},
})
```

Uploads are server-mediated and size-bounded. Each Asset ID owns a new immutable key and checksum. Only assets referenced by a published entry in a public model are anonymously delivered. Draft previews use the authenticated management route and `private, no-store` caching.

Markdown can reference a managed asset with `site-admin://asset/<id>`. These references participate in retention and are rewritten to delivery URLs in public projections.

GC atomically claims only unreferenced, grace-expired assets before deleting the blob. Failed deletes retain metadata for retry. Retained current, published, scheduled, and historical revisions all retain their assets.

The generated Nuxt resolver intentionally accepts only the configured default storage name because `nuxt-files-sdk` v0.0.1 has no public dynamic-name resolver. Trusted non-Nuxt runtimes may inject a wider async `getFiles(storage)` resolver. Native R2 binding injection and direct upload are not claimed by this release.

## Forms and AI

`@liria24/site-admin/form` wraps TanStack Form state with model defaults, server errors, conflict state, and authenticated upload. It is headless and ships no editor widgets.

```ts
import { useSiteAdminForm } from '@liria24/site-admin/form'

const { form, conflict, serverError, upload } = useSiteAdminForm({
    action: `/api/site-admin/entries/${entry.id}`,
    defaultValues: entry.data,
    expectedVersion: entry.version,
    model: descriptor.models.posts,
})
```

`@liria24/site-admin/ai` provides typed, server-owned suggestion actions. AI slug suggestions run only when both the Nuxt AI flag and a domain resolver are configured; failures fall back to deterministic slug generation and never publish or delete content.

## Database operations

New local SQLite databases initialize automatically. D1 and other production databases fail closed until an explicit deployment migration runs:

```ts
import { migrateSiteAdmin } from '@liria24/site-admin/server'

await migrateSiteAdmin(database)
```

The runtime rejects an incompatible schema version. Model `schemaVersion` records semantic validation versions; it does not transform old JSON automatically.

## Scope

Supported now: Nuxt 4/Nitro 2, SQLite, D1 native batches, Comark Content sources, revisions, relations, publishing and scheduling, Files-backed assets, SEO module wiring, sitemap/LLM feeds, locale identity, headless forms, and deterministic optional AI slugs.

Deliberately absent: admin UI, page builder, Ask AI, Eve, generic workflow engine, direct upload, native R2 binding shortcuts, and MCP. MCP waits for a compatible Nuxt MCP Toolkit and authentication stack rather than shipping a provisional protocol or auth layer.

## Development

```sh
bun install
bun run check
```

The package starts at `0.0.0`. Pushes to `main` update an Uppt release PR; merging that PR is the separate release action.
