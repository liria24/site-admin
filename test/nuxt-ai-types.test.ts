import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { siteAdminNuxtClientTemplate, siteAdminNuxtModelTypes } from '../packages/site-admin/src/nuxt/client-templates'

it('infers native fetch and server action names, props, output and choice answers from type-only config', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/ai-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        siteAdminNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', auth: true, aiActions: true }),
    )
    await writeFile(join(directory, 'models.d.ts'), siteAdminNuxtModelTypes(join(directory, 'config.ts')))
    await writeFile(
        join(directory, 'config.ts'),
        `import { defineSiteAdminConfig } from '@liria24/site-admin'
import { Output } from 'ai'
import { z } from 'zod'
import { MockLanguageModelV4, Experimental_DecisionMockModelV4 } from 'ai/test'
export default defineSiteAdminConfig({ models: {}, ai: { model: new MockLanguageModelV4(), decisionModel: new Experimental_DecisionMockModelV4(), actions: {
  proofread: { type: 'text-generation', props: { content: z.string() }, prompt: ({ content }) => content, output: Output.object({ schema: z.object({ content: z.string() }) }) },
  plain: { type: 'text-generation', props: { content: z.string() }, prompt: ({ content }) => content },
  classify: { type: 'decision', props: { content: z.string() }, state: ({ content }) => ({ content }), questions: { category: { type: 'choice', instructions: 'Classify', criteria: { technology: 'Tech', diary: 'Diary' } } } },
} } })`,
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export const useUserSession: () => { user: import('vue').Ref<{ id: string; role?: string } | null>; session: import('vue').Ref<{ id: string } | null> }
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; runWithContext: <Value>(callback: () => Value) => Value; hook: (event: string, callback: (keys?: string[]) => Promise<void>) => () => void }
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { ref } from 'vue'
import { useAiAction } from './client'
import { runAiAction } from '@liria24/site-admin/nuxt/server'
declare const event: Parameters<typeof runAiAction>[0]
const content = ref('Typed')
const { data, status, error, execute } = await useAiAction('proofread', { props: () => ({ content: content.value }), immediate: false })
const output: string | undefined = data.value?.content
const nativeStatus: 'idle' | 'pending' | 'success' | 'error' = status.value
const controller = new AbortController()
const executed: void = await execute({ signal: controller.signal, dedupe: 'cancel' })
const server = await runAiAction(event, 'proofread', { props: { content: 'Typed' } })
const serverContent: string = server.content
const plain = await useAiAction('plain', { props: { content: 'Typed' }, server: false })
const text: string | undefined = plain.data.value
const choice = await useAiAction('classify', { props: { content: 'Typed' } })
const category: 'technology' | 'diary' | undefined = choice.data.value?.category.choice
// @ts-expect-error names come from the config
useAiAction('unknown', { props: {} })
// @ts-expect-error required props are inferred
useAiAction('proofread', { props: {} })
// @ts-expect-error props have their schema input type
useAiAction('proofread', { props: { content: 1 } })
// @ts-expect-error callers cannot change mutation method
useAiAction('proofread', { props: { content: 'Typed' }, method: 'get' })
// @ts-expect-error callers cannot re-enable watching
useAiAction('proofread', { props: { content: 'Typed' }, watch: true })
// @ts-expect-error output remains object typed
const wrong: string = data.value
// @ts-expect-error server names use the same registry
runAiAction(event, 'unknown', { props: {} })
// @ts-expect-error server props use schema input
runAiAction(event, 'proofread', { props: { content: 1 } })
void [output, nativeStatus, error, executed, serverContent, text, category, wrong]
`,
    )
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
            extends: resolve('tsconfig.json'),
            compilerOptions: {
                paths: {
                    vue: [resolve('node_modules/vue/dist/vue.d.mts')],
                    '@liria24/site-admin': [resolve('packages/site-admin/src/index.ts')],
                    '@liria24/site-admin/client': [resolve('packages/site-admin/src/client.ts')],
                    '@liria24/site-admin/nuxt/server': [resolve('packages/site-admin/src/nuxt/server.ts')],
                    '#app': [resolve('node_modules/nuxt/dist/app/index.d.ts')],
                    '#app/composables/asyncData': [resolve('node_modules/nuxt/dist/app/composables/asyncData.d.ts')],
                    '#app/composables/fetch': [resolve('node_modules/nuxt/dist/app/composables/fetch.d.ts')],
                    '#app/composables/addons': [resolve('node_modules/nuxt/dist/app/composables/addons.d.ts')],
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
