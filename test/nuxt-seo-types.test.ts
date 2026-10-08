import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

import { siteAdminNuxtSeoTemplate } from '../packages/site-admin/src/nuxt/client-templates'

it('accepts shared reactive DTOs and validates native second overrides without requiring OG generation', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/seo-types-'))
    await writeFile(join(directory, 'enabled.ts'), siteAdminNuxtSeoTemplate({ ogImage: true }))
    await writeFile(join(directory, 'disabled.ts'), siteAdminNuxtSeoTemplate({ ogImage: false }))
    await writeFile(
        join(directory, 'imports.d.ts'),
        `declare module '#imports' {
  export const useRequestURL: () => URL
  export const useRuntimeConfig: () => { public: { siteAdmin?: unknown } }
  export const useRoute: () => { path: string }
  export const useNuxtApp: () => { runWithContext: <Value>(callback: () => Value) => Value }
  export const useSeoMeta: (input: unknown, options?: { tagPriority?: string }) => unknown
  export { useHead } from '@unhead/vue'
  export const defineOgImage: (component: 'Default.takumi' | 'Home.takumi', props?: { title?: string | import('vue').Ref<string> }, options?: { width?: number; height?: number; key?: string } | Array<{ width?: number; height?: number; key?: string }>) => string[]
}`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { computed, ref } from 'vue'
import type { PublicEntrySeo } from '@liria24/site-admin'
import { useSeo } from './enabled'
import { useSeo as useSeoWithoutOg } from './disabled'
const dto = ref<PublicEntrySeo>()
useSeo(dto)
useSeo(() => dto.value, { titleTemplate: null, robots: 'noindex, follow', image: false })
useSeo(computed(() => dto.value), { image: { component: 'Home.takumi', props: { title: ref('Title') }, options: [{ key: 'og' }, { key: 'square', width: 800, height: 800 }] } })
// Shared DTO component names may come from the server and remain plain strings.
useSeo({ image: { component: 'ServerConfigured.takumi', props: { title: 'Server' } } })
// @ts-expect-error Explicit page overrides validate component names against native OG generation.
useSeo(dto, { image: { component: 'Missing.takumi' } })
// @ts-expect-error Explicit page component props retain native types.
useSeo(dto, { image: { component: 'Default.takumi', props: { title: 123 } } })
// @ts-expect-error Explicit page component options retain native types.
useSeo(dto, { image: { component: 'Default.takumi', options: { width: 'wide' } } })
useSeoWithoutOg(dto, { image: '/image.png', titleTemplate: null })
useSeoWithoutOg(dto, { image: false })
// @ts-expect-error Component generation is unavailable when the optional OG integration is disabled.
useSeoWithoutOg(dto, { image: { component: 'Default.takumi' } })
`,
    )
    const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
            extends: resolve('tsconfig.json'),
            compilerOptions: {
                paths: {
                    '@liria24/site-admin': [resolve('packages/site-admin/src/index.ts')],
                    '@liria24/site-admin/seo': [resolve('packages/site-admin/src/seo.ts')],
                    vue: [resolve('node_modules/vue/dist/vue.d.ts')],
                    '@unhead/vue': [requireNuxt.resolve('@unhead/vue')],
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
