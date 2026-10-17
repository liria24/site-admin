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
  export const useRoute: () => { path: string }
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; callHook: (...args: unknown[]) => Promise<void>; $i18n?: { locale: import('vue').Ref<string> }; runWithContext: <Value>(callback: () => Value) => Value }
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { computed, ref } from 'vue'
import { array, datetime, defineSiteAdminConfig, image, images, markdown, relation, text, textarea, url, type InferSiteAdminPublicModels } from '@liria24/site-admin'
import type { AsyncData } from '#app/composables/asyncData'
import type { NuxtError } from '#app'
import { useContent } from './client'
const config = defineSiteAdminConfig({ models: {
  arts: { fields: { title: text({ required: true }), description: textarea(), href: url(), images: images({ required: true }), createdAt: datetime() } },
  socials: { fields: { href: url({ required: true }), icon: text({ required: true }), label: text({ required: true }) } },
  careers: { fields: { period: text({ required: true }), position: text({ required: true }), company: text({ required: true }) } },
  ranks: { fields: { game: text({ required: true }), season: text(), rank: text({ required: true }), image: image({ required: true }), href: url() } },
  posts: { fields: { title: text({ required: true }), excerpt: textarea(), content: markdown({ required: true }), tags: array(text(), { required: true, default: [] }), image: image(), author: relation('authors'), authorUserId: text(), createdAt: datetime() } },
  authors: { fields: { bio: markdown({ required: true }) } },
  private: { fields: { secret: text() }, public: false },
} })
declare module '@liria24/site-admin/internal/client' {
  interface SiteAdminClientRegistry { publicModels: InferSiteAdminPublicModels<typeof config>; publicSummaryModels: InferSiteAdminPublicModels<typeof config, 'summary'> }
}
const slug = ref('slug')
const locale = ref('ja')
const entry = useContent('posts', { id: slug })
const awaitable: AsyncData<InferSiteAdminPublicModels<typeof config>['posts'] | null | undefined, NuxtError | undefined> = entry
const title: string | undefined = entry.data.value?.data.title
const nodes: import('comark').Node[] | undefined = entry.data.value?.data.content.nodes
const summary: import('comark').Node[] | undefined = entry.data.value?.data.content.meta.summary
// @ts-expect-error Native summary is optional AST, never an excerpt string.
const invalidSummary: string | undefined = entry.data.value?.data.content.meta.summary
const transformed = useContent('posts', { id: () => slug.value,
  transform: (entry) => ({ title: entry?.data.title ?? '' }), default: () => ({ title: '' }),
  locale: computed(() => locale.value), lazy: true, server: false, immediate: false,
  watch: [slug], deep: true, dedupe: 'defer', timeout: 500, enabled: ref(true),
  getCachedData: () => undefined, serialize: false, middleware: [(next) => next()],
 })
const transformedTitle: string = transformed.data.value.title
const titles = useContent('posts', { transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const titleList: string[] = titles.data.value
const summaryList = useContent('posts', { markdown: 'summary' })
const summaryNodes: import('comark').Node[] | undefined = summaryList.data.value?.[0]?.data.content.nodes
// @ts-expect-error Summary rendering documents do not expose arbitrary plugin metadata.
summaryList.data.value?.[0]?.data.content.meta.rawSource
// @ts-expect-error Summary rendering documents do not expose Markdown source.
summaryList.data.value?.[0]?.data.content.source
const summaryTitles = useContent('posts', { markdown: 'summary', transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const summaryTitleList: string[] = summaryTitles.data.value
// @ts-expect-error Summary mode belongs to list requests only.
useContent('posts', { id: 'slug',  markdown: 'summary'  })
// @ts-expect-error Unknown projection modes are rejected.
useContent('posts', { markdown: 'excerpt' })
const picked = useContent('posts', { id: 'slug',  pick: ['data']  })
const pickedTitle: string | undefined = picked.data.value?.data.title
// @ts-expect-error Native pick removes the top-level slug.
picked.data.value?.data.slug
const defaulted = useContent('posts', { id: 'slug',  default: () => null  })
const defaultTitle: string | undefined = defaulted.data.value?.data.title
const asyncTransform = useContent('posts', { transform: async (items) => ({ count: items.length }), default: () => ({ count: 0 }) })
const count: number = asyncTransform.data.value.count
// @ts-expect-error Unknown model names fail through the generated registry.
useContent('missing', { id: 'slug' })
// @ts-expect-error Private models have no public HTTP projection.
useContent('private')
// @ts-expect-error Native options retain their real value types.
useContent('posts', { dedupe: 'invalid' })
// @ts-expect-error There is no second cache/key/selection framework.
useContent('posts', { id: 'slug',  key: 'custom'  })
// @ts-expect-error Public Markdown is a Comark document.
const invalidBody: string | undefined = entry.data.value?.data.content
entry.refresh({ dedupe: 'cancel' })
entry.execute({ signal: new AbortController().signal })
entry.clear()
const batch = useContent({
  arts: { list: 'arts' }, socials: { list: 'socials' }, careers: { list: 'careers' },
  ranks: { list: 'ranks' }, posts: { list: 'posts' }, featured: { entry: 'posts', id: () => slug.value },
}, { locale, dedupe: 'defer' })
const artUrl: string | undefined = batch.data.value?.arts.data[0]?.data.images[0]?.url
const socialHref: string | undefined = batch.data.value?.socials.data[0]?.data.href
const company: string | undefined = batch.data.value?.careers.data[0]?.data.company
const rankImage: string | undefined = batch.data.value?.ranks.data[0]?.data.image.url
const postNodes: import('comark').Node[] | undefined = batch.data.value?.posts.data[0]?.data.content.nodes
const featuredTitle: string | undefined = batch.data.value?.featured.data?.data.title
const itemErrorStatus: number | undefined = batch.data.value?.posts.error?.status
const transformedBatch = useContent({ posts: { list: 'posts' } }, {
  transform: (batch) => batch.posts.data.map((entry) => entry.data.title), default: () => [],
})
const batchTitles: string[] = transformedBatch.data.value
const pickedBatch = useContent({ posts: { list: 'posts' }, arts: { list: 'arts' } }, { pick: ['posts'] })
const pickedPostTitle: string | undefined = pickedBatch.data.value?.posts.data[0]?.data.title
// @ts-expect-error Native pick removes arts from this batch result.
pickedBatch.data.value?.arts
const dynamicBatch = useContent(computed(() => ({ selected: { entry: 'posts', id: slug } } as const)))
const selectedTitle: string | undefined = dynamicBatch.data.value?.selected.data?.data.title
const summaryBatch = useContent({ posts: { list: 'posts', markdown: 'summary' }, featured: { entry: 'posts', id: slug } })
const batchSummaryNodes: import('comark').Node[] | undefined = summaryBatch.data.value?.posts.data[0]?.data.content.nodes
// @ts-expect-error The batch list mode also removes arbitrary plugin metadata.
summaryBatch.data.value?.posts.data[0]?.data.content.meta.rawSource
// @ts-expect-error Batch detail requests retain their full contract.
useContent({ featured: { entry: 'posts', id: slug, markdown: 'summary' } })
void [summaryNodes, summaryTitleList, batchSummaryNodes]
declare const mode: 'full' | 'summary'
const mixedBatch = useContent({ posts: { list: 'posts', markdown: mode } })
const mixedBio: string | import('@liria24/site-admin').SiteAdminMarkdownSummary | undefined = mixedBatch.data.value?.posts.data[0]?.data.author?.data.bio
// @ts-expect-error A runtime union mode cannot promise a raw relation string.
const rawMixedBio: string | undefined = mixedBatch.data.value?.posts.data[0]?.data.author?.data.bio
const fullBatch = useContent({ posts: { list: 'posts', markdown: 'full' } })
const fullBio: string | undefined = fullBatch.data.value?.posts.data[0]?.data.author?.data.bio
const summaryBio: import('@liria24/site-admin').SiteAdminMarkdownSummary | undefined = summaryBatch.data.value?.posts.data[0]?.data.author?.data.bio
void [mixedBio, rawMixedBio, fullBio, summaryBio]
// @ts-expect-error Unknown batch models must fail.
useContent({ item: { list: 'missing' } })
// @ts-expect-error Private batch models must fail.
useContent({ item: { entry: 'private', id: 'entry' } })
// @ts-expect-error Each request is one operation, not both.
useContent({ item: { list: 'posts', entry: 'posts', id: 'entry' } })
// @ts-expect-error Entry requests need a slug/id.
useContent({ item: { entry: 'posts' } })
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
                    '@liria24/site-admin/internal/*': [resolve('packages/site-admin/src/*')],
                    '@liria24/site-admin/internal/client': [resolve('packages/site-admin/src/client.ts')],
                    '#app/*': [resolve('node_modules/nuxt/dist/app/*')],
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
