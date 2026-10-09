import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
    siteAdminNuxtClientTemplate,
    siteAdminNuxtFormTemplate,
    siteAdminNuxtModelTypes,
} from '../packages/site-admin/src/nuxt/client-templates'

it('infers high-level form, management list, field and successful save types from model names', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/management-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', auth: true }),
    )
    await writeFile(join(directory, 'form.ts'), siteAdminNuxtFormTemplate())
    await writeFile(join(directory, 'models.d.ts'), siteAdminNuxtModelTypes(join(directory, 'config.ts')))
    await writeFile(
        join(directory, 'config.ts'),
        `import { array, defineSiteAdminConfig, file, image, images, markdown, object, text } from '@liria24/site-admin'
export default defineSiteAdminConfig({ models: {
  posts: { fields: { title: text({ required: true }), copy: markdown({ required: true }), image: image(), gallery: images(), sections: array(object({ attachment: file() })) } },
  authors: { fields: { name: text({ required: true }) } },
} })
`,
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export const useUserSession: () => { user: import('vue').Ref<{ id: string; role?: string } | null>; session: import('vue').Ref<{ id: string } | null> }
  export const useNuxtApp: () => { runWithContext: <Value>(callback: () => Value) => Value; hook: (event: string, callback: (keys?: string[]) => Promise<void>) => () => void }
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { ref } from 'vue'
import { useSiteAdminForm } from './form'
import { useSiteAdminManagementEntry, useSiteAdminManagementList } from './client'
import type { SiteAdminEntry } from '@liria24/site-admin/client'
import type { InferSiteAdminModels } from '@liria24/site-admin'
import config from './config'
const id = ref<string | null>('post')
const create = await useSiteAdminForm('posts', {})
const editor = await useSiteAdminForm('posts', { id: () => id.value, onSuccess: (saved) => {
  const version: number = saved.version
  if ('data' in saved) { const title: string = saved.data.title; const url: string | undefined = saved.data.image?.url; void [title, url] }
  void version
} })
const title: string = editor.form.state.values.title
const copy: string = editor.form.state.values.copy
const assetUrl: string | undefined = editor.form.state.values.image?.url
const nestedUrl: string | undefined = editor.form.state.values.sections?.[0]?.attachment?.url
editor.form.setFieldValue('title', 'Typed')
editor.form.setFieldValue('image', { id: 'asset', url: '/manage/assets/asset/content' })
editor.ai.proofread(['copy'])
const uploadUrl: string = (await editor.upload(new File(['image'], 'image.png'))).url
const list = useSiteAdminManagementList('posts', { q: ref('search'), locale: ref('ja'), limit: 25 })
const listUrl: string | undefined = list.data.value?.items[0]?.data.image?.url
const transformed = useSiteAdminManagementList('posts', { transform: (page) => page.items.map((item) => item.data.title), default: () => [] })
const titles: string[] = transformed.data.value
const picked = useSiteAdminManagementEntry('posts', 'post', { pick: ['data'] })
const pickedTitle: string | undefined = picked.data.value?.data.title
// @ts-expect-error Native pick removes id.
picked.data.value?.id
declare const raw: SiteAdminEntry<InferSiteAdminModels<typeof config>['posts']>
await useSiteAdminForm('posts', { entry: raw })
// @ts-expect-error entry and id are mutually exclusive.
await useSiteAdminForm('posts', { entry: raw, id })
// @ts-expect-error Unknown model names do not fall back to a string map.
await useSiteAdminForm('missing', {})
// @ts-expect-error Fields are inferred from the model.
editor.form.setFieldValue('title', 123)
// @ts-expect-error Unknown fields fail.
editor.form.setFieldValue('missing', 'x')
// @ts-expect-error AI field selection follows this model.
editor.ai.proofread(['name'])
// @ts-expect-error Raw initialization must not accept transform.
await useSiteAdminForm('posts', { transform: () => ({}) })
// @ts-expect-error Raw initialization must not accept pick.
await useSiteAdminForm('posts', { pick: ['data'] })
// @ts-expect-error Management lists reject unknown models.
useSiteAdminManagementList('missing')
// @ts-expect-error Asset presentation remains an object.
const rawAsset: string = editor.form.state.values.image
const author = await useSiteAdminForm('authors', {})
const authorName: string = author.form.state.values.name
// @ts-expect-error Other model fields are unavailable.
author.form.setFieldValue('title', 'x')
void [create, title, copy, assetUrl, nestedUrl, uploadUrl, listUrl, titles, pickedTitle, rawAsset, authorName]
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
                    '@liria24/site-admin/form': [resolve('packages/site-admin/src/form.ts')],
                    '#build/site-admin/client': [join(directory, 'client.ts')],
                    '#app': [resolve('node_modules/nuxt/dist/app/index.d.ts')],
                    '#app/composables/asyncData': [resolve('node_modules/nuxt/dist/app/composables/asyncData.d.ts')],
                },
            },
            include: ['./*.ts'],
        }),
    )
    const result = await promisify(execFile)(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        join(directory, 'tsconfig.json'),
    ]).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    })
    expect(result.stdout).toBe('')
})
