# @liria24/site-admin

Content models, publishing, authentication, and file management for Nuxt 4.6 and its default Nitro 2 server builder. Build your own administration UI using the server APIs and headless forms.

## Native server API

The Nuxt module requires Nuxt 4.6 and its default Nitro 2 builder. Import handlers and server helpers explicitly from `nuxt/server`; Nuxt 4's auto-imported H3 helpers use a different event shape. Public Site Admin database/authorization hooks now use `RequestEvent`: `event.req` is a Web Request, `event.res.headers` is Headers, and `event.context` is request-local. Read authorization headers from `context.event.req.headers`; the former `context.request` field is removed.

Register `site-admin:database` and `site-admin:authorize` through `useServerHooks()` from `nuxt/server`. Request middleware resolves the configured database before Better Auth routes. The database hook remains an advanced override. Intentional native authorization errors with status 401/403 retain their status; unexpected errors remain sanitized. Better Auth sessions, raw upload input and platform/LLM lifecycle hooks retain small internal Nitro 2 adapters. Nuxt 5 and other server builders have not been validated.

Import `configureSiteAdminRuntime`, `useSiteAdmin` and `useSiteAdminRuntime` from `@liria24/site-admin/nuxt/server`, or use the generated `useSiteAdmin` auto-import. Pass a native event during HTTP requests; omit it only for background operations with application-provided bindings. These runtime helpers are removed from the framework-neutral `/server` entry.

Standalone applications can still import `createSiteAdmin`, `handlePublicRequest` and `handleManagementRequest` from `@liria24/site-admin/server` without installing Nuxt. Their authorization context is generic and their HTTP APIs use Web Request/Response. The exported runtime handlers now require Nuxt; standalone Nitro applications should wrap the core HTTP functions in their own server adapter. Public H3Event hook compatibility and Nuxt versions below 4.6 are no longer supported.

## Install

```sh
bun add @liria24/site-admin
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    modules: ['@liria24/site-admin/nuxt'],

    siteAdmin: {
        enabled: true,
        configFile: './site-admin.config.ts',
        client: { basePath: '/api/content' },
        server: { enabled: true, managementBase: '/api/site-admin' },
        routing: { enabled: true },
        // ai: false, // Optional override to disable configured AI operations
        devtools: true,

        // Integration switches
        auth: true,
        i18n: true,
        seo: true,
        sitemap: true,
        robots: true,
        schemaOrg: true,
        ogImage: true,
        llms: true,
    },

    // Site identity and canonical URL
    site: {
        name: 'Example',
        url: 'https://example.com',
    },

    // Authentication and localization
    auth: {},
    i18n: { defaultLocale: 'en', locales: ['en'] },

    // Search engines, structured data, and social sharing
    seo: {},
    sitemap: {},
    robots: {},
    schemaOrg: {},
    ogImage: {},

    // LLM indexes
    llms: {
        domain: 'https://example.com',
        title: 'Example',
    },

    // Files configuration is selected automatically; a custom filename remains supported.
    // files: { config: 'custom-files.config.ts' },
    devtools: { enabled: true },
})
```

Use `siteAdmin` to enable integrations and configure content APIs and routing. Models, database connections, asset policy, Files options, AI actions and background-task opt-ins belong in `site-admin.config.ts`. The other top-level options configure each integrated module; empty objects use that module's defaults. The authentication, database, and file storage setup used in this example is described below.

Site Admin installs its integration dependencies automatically. If your application directly imports another package's API, declare that package in your application's dependencies as shown below.

## Define content models

```ts
// site-admin.config.ts
import {
    defineSiteAdminAuthorization,
    defineSiteAdminConfig,
    image,
    markdown,
    relation,
    text,
} from '@liria24/site-admin'

export default defineSiteAdminConfig({
    authorization: defineSiteAdminAuthorization({
        editor: { models: { posts: ['create', 'readDraft', 'update'] } },
    }),
    models: {
        authors: {
            fields: { name: text({ required: true }) },
        },
        posts: {
            route: true,
            displayFields: { title: 'title', image: 'cover' },
            fields: {
                author: relation('authors', { required: true }),
                body: markdown(),
                cover: image(),
                title: text({ required: true }),
            },
        },
    },
})
```

Other field types include `textarea`, `number`, `boolean`, `datetime`, `select`, `object`, `array`, `file`, `images`, and `url`. Attach Standard Schema validators to fields or whole models for custom validation.

Models are public by default. Set `public: false` to exclude a model and its content from anonymous reads. `route: true` gives entries public URLs; models without routes can still expose published data through the API. Use `displayFields` to select the fields used for titles, descriptions, and images.

Nuxt aliases work in the configuration file. During development, changes to `site-admin.config.ts` and the selected Files configuration restart Nuxt automatically. Add imported helper files to Nuxt's `watch` option if changes to them should also trigger a restart. Use `siteAdmin.configFile` to select a different configuration file.

## Configure authentication

### Use Site Admin's dependency versions

The Nuxt module provides exported package namespaces backed by its own installed dependencies:
`#better-auth`, `#nuxtjs/better-auth`, `#nuxt-files-sdk`, `#files-sdk`, `#drizzle-orm`,
`#comark`, `#comark-content` and `#ai`. Public subpaths work as well, for example:

```ts
import { defineServerAuth } from '#nuxtjs/better-auth/config'
import { jwt } from '#better-auth/plugins'
import { lastLoginMethodClient } from '#better-auth/client/plugins'
import { defineFilesConfig } from '#nuxt-files-sdk/config'
```

These namespaces work in application/server source, Site Admin/Files/auth configuration files,
generated Nuxt types, and the `site-admin generate` CLI. They are available after the Site Admin
Nuxt module is installed, so use ordinary imports in `nuxt.config.ts` itself. Applications do not
need matching direct dependencies for these imports. Existing namespace aliases, package imports,
TypeScript paths or Vite dedupe settings that conflict produce an error. Native private module IDs
remain owned by their original modules. Browser and server builds retain the resolver's native
package export conditions; importing a namespace does not expose private package files.

Outside Nuxt, configure your test/build runner explicitly:

```ts
import { createSiteAdminDependencyPlugin } from '@liria24/site-admin/dependency-aliases'
export default { plugins: [createSiteAdminDependencyPlugin()] }
```

For a Jiti configuration loader, pass `createSiteAdminDependencyAliases()` as its `alias` option.
For standalone TypeScript, use `createSiteAdminDependencyTypePaths()` as `compilerOptions.paths`.
These build-time helpers do not install a global Node loader or change Node's ordinary imports.

```sh
bun add @nuxtjs/better-auth
```

```ts
// server/auth.config.ts
import { defineServerAuth } from '@nuxtjs/better-auth/config'

export default defineServerAuth({
    emailAndPassword: { enabled: true },
})
```

```ts
// app/auth.config.ts
import { defineClientAuth } from '@nuxtjs/better-auth/config'

export default defineClientAuth({})
```

Set `NUXT_BETTER_AUTH_SECRET` and configure the authentication providers your application needs. Site Admin applies the roles defined in `defineSiteAdminAuthorization()` to management requests. Missing sessions receive `401`; insufficient permissions receive `403`.

The `admin` role has all permissions. The ordinary `user` role has none unless you grant them. To set up the first administrator, create an account and assign its Better Auth `admin` role through a trusted setup script or your database. The first signup is not promoted automatically.

Set `siteAdmin.auth: false` to disable authentication integration and management HTTP routes. Trusted server code can still use `useSiteAdmin()`.

## Set up the database

Site Admin supports SQLite and Cloudflare D1 through Drizzle. The Nuxt module opens the standard connection and supplies Site Admin and Better Auth adapters from the same connection. Your application generates, reviews and applies migrations.

```ts
// site-admin.config.ts
export default defineSiteAdminConfig({
    database: {
        connector: 'sqlite',
        filename: './.data/application.sqlite3',
        schema: './schema.ts',
        authUsePlural: true,
    },
    models: {/* ... */},
})
```

For Cloudflare, use `database: { connector: 'd1', binding: 'DB', schema: './schema.ts' }` and declare the D1 binding in the application's native deployment configuration. Bindings are read from the current request or Nitro task context; the module never connects to a remote database during generation or setup. SQLite and D1 drivers have separate runtime entries, so a D1 consumer does not bundle the module's SQLite driver.

A standard consumer needs no database plugin. The schema path is relative to the application root; SQLite defaults to `./.data/site-admin.sqlite` when `filename` is omitted.

```sh
bun add drizzle-orm@1.0.0-rc.4 @better-auth/drizzle-adapter
bun add -D drizzle-kit@1.0.0-rc.4
```

Generate the content and authentication schema:

```sh
bun x site-admin generate --auth server/auth.config.ts --auth-use-plural --out schema.ts
```

Omit `--auth` when authentication is disabled. Use `--config` for a custom common configuration path, `--env production` for an environment override, and `--prerender` to add its override. Without `--out`, the CLI uses the resolved `database.schema` path (or `schema.ts`). `authUsePlural` also supplies the CLI default unless the flag is explicit.

For local SQLite, configure and run migrations:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
    dialect: 'sqlite',
    schema: './schema.ts',
    out: './drizzle',
    dbCredentials: { url: './.data/application.sqlite3' },
})
```

```sh
bun x drizzle-kit generate --config drizzle.config.ts
bun x drizzle-kit migrate --config drizzle.config.ts
```

Keep the generated schema and migrations under version control. After changing models, regenerate the schema and review the migration, including its effect on historical revisions. Site Admin does not apply migrations automatically. For D1, apply the generated SQL using your deployment tooling.

For a custom connection, override the standard path through the native Nuxt server hook. Replace `useDB()` below with your application's Drizzle connection accessor:

```ts
// server/plugins/site-admin-database.ts
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import { drizzleAdapter as betterAuthAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import * as schema from '../../schema'

import { useServerHooks } from 'nuxt/server'

export default () => {
    useServerHooks().hook('site-admin:database', (context) => {
        const db = useDB(context.event)
        context.database = drizzleAdapter(db, { schema })
        context.authDatabase = betterAuthAdapter(db, {
            provider: 'sqlite',
            schema,
            usePlural: true,
            transaction: false,
        })
    })
}
```

Keep `usePlural` consistent with the CLI's `--auth-use-plural` option. Both adapters should use the same connection. For D1 or other request-bound connections, resolve the connection from `context.event` rather than caching one request's binding globally. When authentication is disabled, omit `authDatabase`.

## Create and publish content

```ts
const siteAdmin = await useSiteAdmin(event)

const draft = await siteAdmin.createEntry('posts', {
    actorId: user.id,
    data: { author: authorId, body: '# Hello', title: 'Hello' },
})

await siteAdmin.publishEntry(draft.id, {
    actorId: user.id,
    expectedVersion: draft.version,
})
```

Changes create revisions and remain drafts until published. Set `publishing: false` on a model to publish each save automatically. Pass the latest `expectedVersion` when updating or publishing to detect conflicting edits.

Required relations must point to public, published entries. Optional relations to unpublished entries appear as `null`. Relations show the target's current published content.

Public projection rejects relation depth above 16 or more than 10,000 expanded entries with `SITE_ADMIN_RELATION_LIMIT` (HTTP 422). Repeated references count each time, and a list shares one allowance across its entries. Publication validates the candidate's relations before committing.

Scheduling an entry alone does not create a cron job. The module registers `site-admin:publish-due`, `site-admin:asset-gc` and `site-admin:sync-assets` Nitro tasks, all disabled by default.

```ts
// site-admin.config.ts
export default defineSiteAdminConfig({
    models: {/* ... */},
    tasks: {
        publishDue: '* * * * *', // Explicit cron schedule
        syncAssets: true, // Explicit permission for manual runs
        assetGC: false, // Destructive cleanup remains disabled
    },
})
```

A boolean `true` enables manual `runTask()` invocation; a nonempty cron string also adds the native Nitro schedule. Disabled tasks reject before opening a database or running cleanup. These tasks call the existing publication, lease-protected asset GC and sync retry use cases. Existing authenticated management task HTTP routes remain unchanged.

Configure Nuxt `routeRules` and CDN caching for the freshness your site needs. Do not share-cache management or draft preview responses.

## HTTP API

| Purpose                  | Default route              |
| ------------------------ | -------------------------- |
| Public content           | `/api/content/**`          |
| Authenticated management | `/api/site-admin/**`       |
| Sitemap source           | `/api/content/_sitemap`    |
| Published assets         | `/api/content/_assets/:id` |
| LLM index                | `/llms.txt`                |

Enable top-level `llms.full` for `/llms-full.txt`. Management APIs cover content editing, revisions, publishing, scheduling, sorting, assets, and AI proposals.

Send JSON mutations with `Content-Type: application/json`; browser mutations must be same-origin. Bulk ordering uses `POST /api/site-admin/entries/:model/reorder` with `{ items: [{ id, sortOrder, expectedVersion }] }`.

`GET /api/site-admin/entries` accepts `model`, `locale`, `q`, `limit` (1–100, default 50), and `offset` (non-negative, default 0). It returns `{ items, total, limit, offset }` after permission and search filtering. Fetch every page before reordering a complete list.

Entry mutations return the full entry to actors with `readDraft`; other authorized actors receive only `{ id, model, version, sortOrder }` (`EntryMutationReceipt`). Draft-derived validation details are also withheld. AI proposals require both `ai` and `readDraft`.

## Store files and images

Put native Files SDK options directly at the top level of the common configuration. `assets` contains Site Admin policy and an optional storage reference, never physical provider definitions.

```ts
// site-admin.config.ts
import { defineSiteAdminConfig } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    storage: { content: { adapter: 'memory' } },
    assets: { maxUploadSize: 10_000_000, cleanup: { minimumAge: 86400 } },
    models: {/* ... */},
    $development: {
        storage: { content: { adapter: 'fs', config: { root: '.data/files/content' } } },
        assets: { maxUploadSize: 20_000_000 },
    },
})
```

Files option types come from `nuxt-files-sdk`; future native Files options do not require a Site Admin copy. The common file supports `$development`, `$production`, `$test`, `$prerender` and named `$env` overrides. Domain objects merge recursively and arrays replace; functions keep their identity. Physical provider options, credentials and environment overrides are resolved by Files SDK itself.

An existing `files.config.ts` takes precedence in full over the common file's physical Files settings. There is no merge or conflict detector. Explicit Files module filenames keep Nuxt's normal inline-option > top-level-option precedence. If no standalone Files config exists, Site Admin passes the common filename through the existing single-string `files.config` option. The SDK is unchanged.

One storage needs no `assets.storage` selection; multiple storages require its explicit name. An unnamed single storage uses the internal `default` reference while calling the SDK's unnamed client. Both files remain server-only runtime sources; public manifests contain only approved descriptors and projections.

`maxUploadSize` is in bytes; no application size limit is set by default. Platform and storage limits still apply. When using R2 on Cloudflare Workers, enable `nodejs_compat`.

Only assets referenced by published entries in public models are publicly served. Draft previews require authentication. Markdown can reference an asset with `site-admin://asset/<id>`.

`content()` resolves asset URLs in Markdown links, images and static `src`/`href`/`xlink:href` component props, preserving code and text examples. Public entry APIs retain their existing URL-resolved Markdown strings. Reference collection remains conservative to preserve retained-revision asset protection. See [internal Markdown processing](https://github.com/liria24/site-admin/blob/main/docs/internal-markdown.md) for plugin ordering, supported syntax and compatibility details.

This API check does not make a public bucket private. For private originals, explicitly set `assets.separateDrafts: true` and configure a genuinely private Files SDK storage named `draft`, distinct from `assets.storage`. The default is `false`; defining a `draft` storage alone does not enable separation.

In separated mode, originals stay in `draft`, including those retained by historical revisions. Valid public references get copies in the usual storage; the last public reference removes its copy. Draft edits keep the current published copy. Configuration errors never fall back to public storage. Existing originals or a changed storage mode require an explicit migration with old writers stopped before enabling the new configuration.

Copy I/O uses durable records, a database lease, unique attempt keys, and checksum verification. If synchronization fails after an entry commit, the mutation reports HTTP 503 and the entry is already saved: read its latest version and retry via `syncAssetCopies()`, `publishDue()`, or asset GC. Run these from a scheduler even when no entries are due. Database state and object storage cannot commit atomically; interrupted public-copy cleanup is retried while the public API immediately checks the current publication state.

Use `managementAssetUrl(id, managementBase?)` from `@liria24/site-admin/client` for authenticated previews. `PublicAsset`, `PublicEntry<Data>`, `InferPublicModelData`, and `InferSiteAdminPublicModels` describe public projections, including asset URLs and expanded relations.

`useSiteAdminForm()` handles uploads. For direct HTTP uploads, send the raw File body with `x-filename: encodeURIComponent(file.name)` and `x-upload-size: String(file.size)`; multipart uploads are not supported.

Run asset GC from your own scheduler. It removes unreferenced assets older than `cleanup.minimumAge` seconds from creation. Historical revisions also retain their assets, so prune unwanted revisions before expecting those assets to be collected.

## Generate OG images

Site Admin enables `nuxt-og-image`. Create a component such as `app/components/OgImage/Home.takumi.vue`, then call `defineOgImage('Home.takumi', props, options)` from a page.

Choose `.takumi.vue`, `.satori.vue`, or `.browser.vue` components and install the renderer dependencies requested by `nuxt-og-image` before building. Configure the renderer using Nuxt's native `ogImage` options. Set `siteAdmin.ogImage: false` to disable the integration.

With SEO enabled, the Nuxt module auto-imports `defineSeo({ title, titleTemplate, description, type, twitterCard, image })`.
It applies page, Open Graph and Twitter metadata. `type` defaults to `website`, and `twitterCard` to `summary_large_image`.
The optional image uses `{ component, props, options }`, typed from Nuxt's native `defineOgImage` arguments.
When OG image support is disabled, the helper does not load or accept image-generation options.
Keep your site's brand defaults, favicon and OG components in the application.

## Build forms

`@liria24/site-admin/form` provides headless form state, validation errors, conflict handling, and authenticated uploads. It requires Vue 3.6 and `@tanstack/vue-form` 2.0.0-alpha.2.

```ts
import { useSiteAdminForm } from '@liria24/site-admin/form'

const controller = useSiteAdminForm({
    descriptor: descriptor.models.posts,
    entry,
    managementBase: '/api/site-admin',
    modelName: 'posts',
})

await controller.form.handleSubmit()
```

In Nuxt, install the optional form peer and use the generated model-name overload:

```ts
const controller = await useSiteAdminForm('posts', { entry })
```

Call and await this overload during component setup. It gets the actor-filtered descriptor from the management API, resolves the model and management paths internally, and retains Vue's form mount/cleanup context. Private descriptors and defaults are never baked into browser JavaScript. The explicit-options `/form` API above remains synchronous and usable outside Nuxt. Neither the core nor public-client runtime imports Vue or TanStack.

`useSiteAdminManagementClient()` provides typed create/update/delete, publication, scheduling, revision, reference and file operations using the existing management contracts. Generated `useSiteAdminClient().list('posts')` and `get('posts', id)` infer the selected build environment's public model shape and reject unknown/private model names.

Use `management.listAllEntries('posts', { locale: 'ja' })` when management UI ordering needs every entry, not only the first page.
It fetches 100 entries per page by default, preserves filters/custom limits, advances by actual returned item counts,
and rejects an empty intermediate page rather than returning an incomplete ordering list.

Public HTTP content returns parsed Comark documents for Markdown fields, including nested object/array fields;
the inferred public model types reflect that shape. Expanded relation targets retain their existing URL-resolved
Markdown string projection. Management drafts and direct server projections remain editable strings.

After creation, later submissions update the same entry. Publishing, scheduling, restoring revisions, and deleting entries are separate actions.

`onSuccess` receives `EntryMutationResult`, which can be a receipt for actors without `readDraft`. Receipt submissions retain the submitted form values and update the entry ID/version. In public inferred types, relation data is partial because a cycle boundary returns an empty data object.

## Add AI suggestions

Site Admin owns AI SDK generation, structured-output parsing and validation. Select the native Cloudflare provider in the common server configuration:

```ts
// site-admin.config.ts
import { defineSiteAdminConfig, markdown, text, textarea } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    ai: { provider: 'workers-ai', model: 'openai/gpt-6-luna', binding: 'AI' },
    models: {
        posts: {
            displayFields: { title: 'title', description: 'excerpt' },
            fields: {
                title: text({ required: true }),
                body: markdown({ required: true }),
                excerpt: textarea({ maxLength: 180 }),
            },
        },
    },
})
```

Declare the native `AI` binding in your application's Cloudflare configuration. `binding` defaults to `AI`. Configuration activates the AI operations; an explicit `siteAdmin.ai: false` still disables them. Missing AI bindings do not prevent ordinary CRUD or server startup. Only an AI operation resolves the current request's binding, avoiding cross-request binding capture. There is no API-key or REST fallback.

The implementation uses the official `workers-ai-provider` OpenAI plugin and AI SDK structured output for third-party OpenAI models. Native `@cf/...` identifiers use the same adapter's native path. Provider/runtime code is isolated in `/ai/workers-ai`; core, server and public-client imports do not eagerly load AI SDK code. Actual model availability and AI Gateway/billing readiness must be verified on the target account before production use.

Use the typed management client with an unsaved draft:

```ts
const management = useSiteAdminManagementClient()
const metadata = await management.generateMetadata('posts', {
    data: draft,
    slug: manualSlugValue,
    generate: { slug: !manualSlugEnabled, excerpt: !manualExcerptEnabled },
})
const proofreading = await management.proofreadDraft('posts', { data: draft, fields: ['body'] })
```

The corresponding POST routes are `/api/site-admin/models/posts/ai/metadata` and `/api/site-admin/models/posts/ai/proofread`. They require the model's `ai` permission. Unlike stored-entry AI actions, they do not read a stored draft and therefore do not require `readDraft` solely to process caller-supplied data.

Both return `{ data, issues, slug? }` proposals and never save, publish or apply them. Metadata replaces only fields explicitly selected by `generate`; false flags preserve manual values, including empty strings for ordinary validation. The excerpt target is the model's `displayFields.description` text/textarea field, or `excerpt`. Proofreading accepts top-level text, textarea and Markdown fields, preserves protected asset references, and returns an explicit reviewable proposal. Display validation issues before saving, and apply proofreading only after confirmation while retaining the draft's original concurrency version.

SDK parsing rejects malformed/refused/truncated/invalid structured responses. Error responses are sanitized: unavailable AI is 503; provider and output failures are 502. No retry or fallback silently overwrites manual values. Live inference is not part of the local test suite; mocked native-binding tests verify the provider wire format and structured validation without charges.

Custom `ai.models` actions and the existing stored-entry proposal/apply workflow remain supported in the common file. There is no separate `site-admin.ai.ts` or `defineSiteAdminAIConfig`. Provider/model instances and action code stay server-only. Configuration can be evaluated during build and server initialization, so defer network calls and other side effects to action/resolver functions; eager initializers may execute in Files SDK's separately selected server module as well.

## Inspect your configuration

During development, Nuxt DevTools includes a Site Admin inspector for models, routes, database readiness, and asset settings. It requires an authenticated user with `system.diagnostics` permission. Set `siteAdmin.devtools: false` to disable it.

## Try a preview version

When a PR has a package preview, install the tarball URL from its pkg.pr.new comment to try the change in your application.

## Workspace development

Use the supported Node runtime from `package.json` and Bun 1.4.2. Install with `bun ci`; the workspace pins Vite+ 1.1.0 and its Vite core through the Bun catalog. No global Vite+ installation is required.

- On runtimes without Unix sockets, `NITRO_NO_UNIX_SOCKET=1 bun run check` selects Nitro's supported TCP mode and a loopback-only IPC probe for the shutdown regression. The normal Unix/Windows transport remains the default and must also pass in CI.
- `bun run format:check`, `bun run lint`, and `bun run test` use the local Vite+ toolchain.
- `bun run build` runs `vp pack` for the library and its DevTools client.
- `bun run check` runs all local gates, including Nuxt dev/HMR and production SSR, local Cloudflare, package validation, and packed consumers. Run `SITE_ADMIN_PACKAGE_MANAGER=npm bun run test:packed` and `SITE_ADMIN_PACKAGE_MANAGER=pnpm bun run test:packed` for the other CI consumer installers.

Vitest imports stay on `vitest` for Nuxt test-utils compatibility; Vite+ provides the runner and pins the same Vitest version. Update Vite+, its core alias, and Vitest together using the target version's migrator, then rerun every gate.
