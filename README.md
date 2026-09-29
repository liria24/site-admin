# @liria24/site-admin

Content models, publishing, authentication, and file management for Nuxt 4 and Nitro 2. Build your own administration UI using the server APIs and headless forms.

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
        assets: { storage: 'content' }, // Named storage defined in files.config.ts
        ai: false, // Set to {} to load site-admin.ai.ts
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

    // File storage and development tools
    files: { config: 'files.config.ts' },
    devtools: { enabled: true },
})
```

Use `siteAdmin` to enable integrations and configure content APIs, routing, assets, and AI. The other top-level options configure each integrated module; empty objects use that module's defaults. The authentication, database, and file storage setup used in this example is described below.

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

Nuxt aliases work in the configuration file. During development, changes to `site-admin.config.ts` and an enabled AI configuration restart Nuxt automatically. Add imported helper files to Nuxt's `watch` option if changes to them should also trigger a restart. Use `siteAdmin.configFile` to select a different configuration file.

## Configure authentication

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

Site Admin supports SQLite and Cloudflare D1 through Drizzle. Your application creates the connection and runs migrations.

```sh
bun add drizzle-orm@1.0.0-rc.4 @better-auth/drizzle-adapter
bun add -D drizzle-kit@1.0.0-rc.4
```

Generate the content and authentication schema:

```sh
bun x site-admin generate --auth server/auth.config.ts --auth-use-plural --out schema.ts
```

Omit `--auth` when authentication is disabled. Use `--config` for a custom Site Admin configuration path.

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

Provide the database adapters through a Nitro plugin. Replace `useDB()` below with your application's Drizzle connection accessor:

```ts
// server/plugins/site-admin-database.ts
import { drizzleAdapter } from '@liria24/site-admin/adapters/drizzle'
import { drizzleAdapter as betterAuthAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import * as schema from '../../schema'

export default defineNitroPlugin((app) => {
    app.hooks.hook('site-admin:database', (context) => {
        const db = useDB(context.event)
        context.database = drizzleAdapter(db, { schema })
        context.authDatabase = betterAuthAdapter(db, {
            provider: 'sqlite',
            schema,
            usePlural: true,
            transaction: false,
        })
    })
})
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

For scheduled publication, call `publishDue()` or POST `/api/site-admin/tasks/publish-due` from a Nitro Task or platform scheduler. Scheduling an entry alone does not create a cron job.

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

## Store files and images

Declare a named storage using `nuxt-files-sdk`:

```sh
bun add nuxt-files-sdk
```

```ts
// files.config.ts
import { defineFilesConfig } from 'nuxt-files-sdk/config'

export default defineFilesConfig({
    storage: {
        content: {
            adapter: 'fs',
            config: { root: '.data/files/content' },
        },
    },
})
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
    siteAdmin: {
        assets: {
            storage: 'content',
            maxUploadSize: 10_000_000,
            cleanup: { minimumAge: 86400 },
        },
    },
})
```

`maxUploadSize` is in bytes; no application size limit is set by default. Platform and storage limits still apply. When using R2 on Cloudflare Workers, enable `nodejs_compat`.

Only assets referenced by published entries in public models are publicly served. Draft previews require authentication. Markdown can reference an asset with `site-admin://asset/<id>`.

`useSiteAdminForm()` handles uploads. For direct HTTP uploads, send the raw File body with `x-filename: encodeURIComponent(file.name)` and `x-upload-size: String(file.size)`; multipart uploads are not supported.

Run asset GC from your own scheduler. It removes unreferenced assets older than `cleanup.minimumAge` seconds from creation. Historical revisions also retain their assets, so prune unwanted revisions before expecting those assets to be collected.

## Generate OG images

Site Admin enables `nuxt-og-image`. Create a component such as `app/components/OgImage/Home.takumi.vue`, then call `defineOgImage('Home.takumi', props, options)` from a page.

Choose `.takumi.vue`, `.satori.vue`, or `.browser.vue` components and install the renderer dependencies requested by `nuxt-og-image` before building. Configure the renderer using Nuxt's native `ogImage` options. Set `siteAdmin.ogImage: false` to disable the integration.

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

After creation, later submissions update the same entry. Publishing, scheduling, restoring revisions, and deleting entries are separate actions.

## Add AI suggestions

Enable `siteAdmin.ai: {}` and define suggestion actions in `site-admin.ai.ts` using `defineSiteAdminAIConfig` from `@liria24/site-admin/ai`. Use `siteAdmin.ai.configFile` for a different file path.

Actions return proposals for review. Applying a proposal saves an update; it does not publish or delete content.

## Inspect your configuration

During development, Nuxt DevTools includes a Site Admin inspector for models, routes, database readiness, and asset settings. It requires an authenticated user with `system.diagnostics` permission. Set `siteAdmin.devtools: false` to disable it.

## Try a preview version

When a PR has a package preview, install the tarball URL from its pkg.pr.new comment to try the change in your application.
