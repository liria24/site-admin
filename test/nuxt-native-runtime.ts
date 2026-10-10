import { readFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { createError } from 'h3'
import * as Vue from 'vue'

const requireNuxt = createRequire(import.meta.resolve('nuxt/package.json'))
const root = dirname(requireNuxt.resolve('nuxt/package.json'))
export const readNuxtSource = (path: string) => readFile(join(root, 'dist/app', path), 'utf8')
const plain = (source: string) => source.replace(/^import .*$/gmu, '').replace(/^export .*$/gmu, '')

export const nativeRuntimeSource = (source: string, { serverRuntime = false, asyncData = false } = {}) => {
    const script = plain(source)
    return (asyncData ? script.replace(/^const createUseAsyncData =.*?^\}\);/gmsu, '') : script)
        .replaceAll('import.meta.client', String(!serverRuntime))
        .replaceAll('import.meta.server', String(serverRuntime))
        .replaceAll('import.meta.dev', 'false')
        .replaceAll('import.meta.prerender', 'false')
}

export const generatedRuntimeSource = (source: string, { serverFetch = false, asyncData = false } = {}) => {
    const script = stripTypeScriptTypes(source).replace(/^import .*$/gmu, '')
    return (asyncData ? script.replace(/^export const siteAdminAsyncData = createUseAsyncData\(\)\s*$/gmu, '') : script)
        .replace(/^export /gmu, '')
        .replaceAll('import.meta.server', String(serverFetch))
}

export const nativeNuxtDependencies = async (app: object, { purgeCachedData = false } = {}) => {
    const debounceSource = plain(await readNuxtSource('utils/debounce-tick.js'))
    const debounceTick = new Function('queuePostFlushCb', `${debounceSource}; return debounceTick`)(
        Vue.queuePostFlushCb,
    ) as unknown
    return {
        ...Object.fromEntries(Object.entries(Vue).filter(([name]) => /^[a-zA-Z_$][a-zA-Z_$0-9]*$/u.test(name))),
        useNuxtApp: () => app,
        createError,
        debounceTick,
        asyncDataDefaults: { deep: false },
        granularCachedData: true,
        pendingWhenIdle: false,
        purgeCachedData,
        stripNeverHydratedData: false,
        tracingChannelNuxt: false,
        vapor: false,
        clientOnlySymbol: Symbol('client-only'),
    }
}

export const nativeNuxtHash = async (): Promise<unknown> => (await import(join(root, 'dist/app/utils/hash.js'))).hashKey
