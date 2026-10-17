import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { siteAdminNuxtClientTemplate, siteAdminNuxtModelTypes } from '../packages/site-admin/src/nuxt/client-templates'

it('infers high-level form, management list, field and successful save types from model names', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/management-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', auth: true }),
    )
    await writeFile(join(directory, 'models.d.ts'), siteAdminNuxtModelTypes(join(directory, 'config.ts')))
    await writeFile(
        join(directory, 'config.ts'),
        `import { array, defineSiteAdminConfig, file, image, images, markdown, object, text } from '@liria24/site-admin'
import { Output } from 'ai'
import { z } from 'zod'
export default defineSiteAdminConfig({ models: {
  posts: { fields: { title: text({ required: true }), copy: markdown({ required: true }), image: image(), gallery: images(), sections: array(object({ attachment: file() })) } },
  authors: { fields: { name: text({ required: true }) } },
}, ai: { actions: {
  publication: { type: 'text-generation', input: z.object({ mode: z.enum(['automatic', 'manual']) }), prompt: ({ mode }) => mode, output: Output.object({ schema: z.object({ data: z.object({ title: z.string().optional(), copy: z.string().optional() }), slug: z.string().optional() }) }) },
  correct: { type: 'text-generation', input: z.object({ content: z.string(), fields: z.array(z.enum(['copy'])) }), prompt: ({ content }) => content, output: Output.object({ schema: z.object({ data: z.object({ copy: z.string() }) }) }) },
  plain: { type: 'text-generation', input: z.object({}), prompt: () => 'Plain' },
} } })
`,
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRoute: () => { path: string }
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export const useUserSession: () => { user: import('vue').Ref<{ id: string; role?: string } | null>; session: import('vue').Ref<{ id: string } | null> }
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; callHook: (...args: unknown[]) => Promise<void>; runWithContext: <Value>(callback: () => Value) => Value; hook: (event: string, callback: (keys?: string[]) => Promise<void>) => () => void }
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { ref } from 'vue'
import { useAdminEntries, useAdminEntry, useAdminForm } from './client'
const id = ref<string | null>('post')
const post = await useAdminEntry('posts', id)
const immediate = useAdminForm('posts', { instance: ref('one') })
const immediateTitle: string = immediate.form.state.values.title
immediate.upload('sections[0].attachment', new File(['x'], 'x.txt'))
// @ts-expect-error Unknown nested field.
immediate.upload('sections[0].missing', new File(['x'], 'x.txt'))
void immediateTitle
const { form } = await useAdminForm('posts', { id, onSuccess: (saved) => {
    const version: number = saved.version
    if ('data' in saved) { const title: string = saved.data.title; const url: string | undefined = saved.data.image?.url; void [title, url] }
    void version
} })
const title: string = form.state.values.title
const copy: string = form.state.values.copy
const assetUrl: string | undefined = form.state.values.image?.url
form.setFieldValue('title', 'Typed')
form.setFieldValue('image', { id: 'asset', url: '/manage/assets/asset/content' })
// @ts-expect-error Unknown model.
useAdminEntries('missing')
// @ts-expect-error Admin response shapes are fixed.
useAdminEntries('posts', { transform: () => ({}) })
// @ts-expect-error Admin response shapes are fixed.
useAdminEntries('posts', { pick: ['data'] })
// @ts-expect-error Fields retain their schema types.
form.setFieldValue('title', 12)
// @ts-expect-error Unknown field.
form.setFieldValue('missing', '')
// @ts-expect-error Optional assets require presentation URLs.
form.setFieldValue('image', { id: 'asset' })
// @ts-expect-error No second AI execution engine lives in a form.
form.ai.run('correct', {})
const page = ref(2)
const list = await useAdminEntries('posts', { page })
const first: string | undefined = list.data.value?.items[0]?.data.title
const total: number | undefined = list.data.value?.total
const one: string | undefined = post.data.value?.data.title
const { form: author } = await useAdminForm('authors')
const name: string = author.state.values.name
void [title, copy, assetUrl, first, total, one, name]

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
                    '@liria24/site-admin/internal/form': [resolve('packages/site-admin/src/form.ts')],
                    '@liria24/site-admin/internal/model': [resolve('packages/site-admin/src/model.ts')],
                    '#build/site-admin/client': [join(directory, 'client.ts')],
                    '#app/*': [resolve('node_modules/nuxt/dist/app/*')],
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
