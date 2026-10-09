import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

import { siteAdminNuxtClientTemplate } from '../packages/site-admin/src/nuxt/client-templates'

it('preserves model-specific public data and native AsyncData options/transform/pick/default inference', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/public-data-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', i18n: true }),
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; $i18n?: { locale: import('vue').Ref<string> }; runWithContext: <Value>(callback: () => Value) => Value }
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { computed, ref } from 'vue'
import { array, datetime, defineSiteAdminConfig, image, images, markdown, text, textarea, url, type InferSiteAdminPublicModels } from '@liria24/site-admin'
import type { AsyncData } from '#app/composables/asyncData'
import type { NuxtError } from '#app'
import { useSiteAdminBatch, useSiteAdminEntry, useSiteAdminList } from './client'
const config = defineSiteAdminConfig({ models: {
  arts: { fields: { title: text({ required: true }), description: textarea(), href: url(), images: images({ required: true }), createdAt: datetime() } },
  socials: { fields: { href: url({ required: true }), icon: text({ required: true }), label: text({ required: true }) } },
  careers: { fields: { period: text({ required: true }), position: text({ required: true }), company: text({ required: true }) } },
  ranks: { fields: { game: text({ required: true }), season: text(), rank: text({ required: true }), image: image({ required: true }), href: url() } },
  posts: { fields: { title: text({ required: true }), excerpt: textarea(), content: markdown({ required: true }), tags: array(text(), { required: true, default: [] }), image: image(), authorUserId: text(), createdAt: datetime() } },
  private: { fields: { secret: text() }, public: false },
} })
declare module '@liria24/site-admin/client' {
  interface SiteAdminClientRegistry { publicModels: InferSiteAdminPublicModels<typeof config>; publicSummaryModels: InferSiteAdminPublicModels<typeof config, 'summary'> }
}
const slug = ref('slug')
const locale = ref('ja')
const entry = useSiteAdminEntry('posts', slug)
const awaitable: AsyncData<InferSiteAdminPublicModels<typeof config>['posts'] | null | undefined, NuxtError | undefined> = entry
const title: string | undefined = entry.data.value?.data.title
const nodes: import('comark').Node[] | undefined = entry.data.value?.data.content.nodes
const summary: import('comark').Node[] | undefined = entry.data.value?.data.content.meta.summary
// @ts-expect-error Native summary is optional AST, never an excerpt string.
const invalidSummary: string | undefined = entry.data.value?.data.content.meta.summary
const transformed = useSiteAdminEntry('posts', () => slug.value, {
  transform: (entry) => ({ title: entry?.data.title ?? '' }), default: () => ({ title: '' }),
  locale: computed(() => locale.value), lazy: true, server: false, immediate: false,
  watch: [slug], deep: true, dedupe: 'defer', timeout: 500, enabled: ref(true),
  getCachedData: () => undefined, serialize: false, middleware: [(next) => next()],
})
const transformedTitle: string = transformed.data.value.title
const titles = useSiteAdminList('posts', { transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const titleList: string[] = titles.data.value
const summaryList = useSiteAdminList('posts', { markdown: 'summary' })
const summaryNodes: import('comark').Node[] | undefined = summaryList.data.value?.[0]?.data.content.nodes
// @ts-expect-error Summary rendering documents do not expose arbitrary plugin metadata.
summaryList.data.value?.[0]?.data.content.meta.rawSource
// @ts-expect-error Summary rendering documents do not expose Markdown source.
summaryList.data.value?.[0]?.data.content.source
const summaryTitles = useSiteAdminList('posts', { markdown: 'summary', transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const summaryTitleList: string[] = summaryTitles.data.value
// @ts-expect-error Summary mode belongs to list requests only.
useSiteAdminEntry('posts', 'slug', { markdown: 'summary' })
// @ts-expect-error Unknown projection modes are rejected.
useSiteAdminList('posts', { markdown: 'excerpt' })
const picked = useSiteAdminEntry('posts', 'slug', { pick: ['data'] })
const pickedTitle: string | undefined = picked.data.value?.data.title
// @ts-expect-error Native pick removes the top-level slug.
picked.data.value?.slug
const defaulted = useSiteAdminEntry('posts', 'slug', { default: () => null })
const defaultTitle: string | undefined = defaulted.data.value?.data.title
const asyncTransform = useSiteAdminList('posts', { transform: async (items) => ({ count: items.length }), default: () => ({ count: 0 }) })
const count: number = asyncTransform.data.value.count
// @ts-expect-error Unknown model names fail through the generated registry.
useSiteAdminEntry('missing', 'slug')
// @ts-expect-error Private models have no public HTTP projection.
useSiteAdminList('private')
// @ts-expect-error Native options retain their real value types.
useSiteAdminList('posts', { dedupe: 'invalid' })
// @ts-expect-error There is no second cache/key/selection framework.
useSiteAdminEntry('posts', 'slug', { key: 'custom' })
// @ts-expect-error Public Markdown is a Comark document.
const invalidBody: string | undefined = entry.data.value?.data.content
entry.refresh({ dedupe: 'cancel' })
entry.execute({ signal: new AbortController().signal })
entry.clear()
const batch = useSiteAdminBatch({
  arts: { list: 'arts' }, socials: { list: 'socials' }, careers: { list: 'careers' },
  ranks: { list: 'ranks' }, posts: { list: 'posts' }, featured: { entry: 'posts', slugOrId: () => slug.value },
}, { locale, dedupe: 'defer' })
const artUrl: string | undefined = batch.data.value?.arts.data[0]?.data.images[0]?.url
const socialHref: string | undefined = batch.data.value?.socials.data[0]?.data.href
const company: string | undefined = batch.data.value?.careers.data[0]?.data.company
const rankImage: string | undefined = batch.data.value?.ranks.data[0]?.data.image.url
const postNodes: import('comark').Node[] | undefined = batch.data.value?.posts.data[0]?.data.content.nodes
const featuredTitle: string | undefined = batch.data.value?.featured.data?.data.title
const itemErrorStatus: number | undefined = batch.data.value?.posts.error?.status
const transformedBatch = useSiteAdminBatch({ posts: { list: 'posts' } }, {
  transform: (batch) => batch.posts.data.map((entry) => entry.data.title), default: () => [],
})
const batchTitles: string[] = transformedBatch.data.value
const pickedBatch = useSiteAdminBatch({ posts: { list: 'posts' }, arts: { list: 'arts' } }, { pick: ['posts'] })
const pickedPostTitle: string | undefined = pickedBatch.data.value?.posts.data[0]?.data.title
// @ts-expect-error Native pick removes arts from this batch result.
pickedBatch.data.value?.arts
const dynamicBatch = useSiteAdminBatch(computed(() => ({ selected: { entry: 'posts', slugOrId: slug } } as const)))
const selectedTitle: string | undefined = dynamicBatch.data.value?.selected.data?.data.title
const summaryBatch = useSiteAdminBatch({ posts: { list: 'posts', markdown: 'summary' }, featured: { entry: 'posts', slugOrId: slug } })
const batchSummaryNodes: import('comark').Node[] | undefined = summaryBatch.data.value?.posts.data[0]?.data.content.nodes
// @ts-expect-error The batch list mode also removes arbitrary plugin metadata.
summaryBatch.data.value?.posts.data[0]?.data.content.meta.rawSource
// @ts-expect-error Batch detail requests retain their full contract.
useSiteAdminBatch({ featured: { entry: 'posts', slugOrId: slug, markdown: 'summary' } })
void [summaryNodes, summaryTitleList, batchSummaryNodes]
// @ts-expect-error Unknown batch models must fail.
useSiteAdminBatch({ item: { list: 'missing' } })
// @ts-expect-error Private batch models must fail.
useSiteAdminBatch({ item: { entry: 'private', slugOrId: 'entry' } })
// @ts-expect-error Each request is one operation, not both.
useSiteAdminBatch({ item: { list: 'posts', entry: 'posts', slugOrId: 'entry' } })
// @ts-expect-error Entry requests need a slug/id.
useSiteAdminBatch({ item: { entry: 'posts' } })
// @ts-expect-error Item errors are serializable records without stacks/causes.
batch.data.value?.posts.error?.stack
batch.refresh()
batch.clear()
void [artUrl, socialHref, company, rankImage, postNodes, featuredTitle, itemErrorStatus, batchTitles, pickedPostTitle, selectedTitle]
const status: string = entry.status.value
const error: NuxtError | undefined = entry.error.value
void [awaitable, title, nodes, summary, invalidSummary, transformedTitle, titleList, pickedTitle, defaultTitle, count, invalidBody, status, error]
`,
    )
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
            extends: resolve('tsconfig.json'),
            compilerOptions: {
                paths: {
                    '@liria24/site-admin': [resolve('packages/site-admin/src/index.ts')],
                    '@liria24/site-admin/client': [resolve('packages/site-admin/src/client.ts')],
                    '#app': [resolve('node_modules/nuxt/dist/app/index.d.ts')],
                    '#app/composables/asyncData': [resolve('node_modules/nuxt/dist/app/composables/asyncData.d.ts')],
                    vue: [resolve('node_modules/vue/dist/vue.d.ts')],
                },
            },
            include: ['./*.ts'],
        }),
    )
    const run = promisify(execFile)
    const result = await run(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        join(directory, 'tsconfig.json'),
    ]).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    })
    expect(result.stdout).toBe('')
})
