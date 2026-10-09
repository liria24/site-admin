import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { applyNuxt46VerificationPatch } from './nuxt-compatibility.ts'

const wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))
const listen = (server) =>
    new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
    })
const close = (server) => new Promise((resolve) => server.close(resolve))
// Chromium descendants can finish profile writes after the owned process exits.
export const removePublicDataConsumer = (directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
const stop = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, wait(5_000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export const chromiumProbe = async (origin, directory) => {
    const profile = join(directory, 'chromium-profile')
    const configHome = join(directory, 'chromium-config')
    await mkdir(configHome, { recursive: true })
    const executable = process.env.CHROMIUM_PATH ?? 'chromium'
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4_096 })
    const versionDetails = {
        output: version.stdout?.trim().slice(-300),
        stderr: version.stderr?.trim().slice(-300),
        exit: version.status,
        signal: version.signal,
        error: version.error?.code,
    }
    const started = performance.now()
    const browser = spawn(
        executable,
        [
            '--headless',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            'about:blank',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: configHome } },
    )
    let browserLogs = ''
    let browserOutput = ''
    let portState = { error: 'not-read' }
    browser.stdout.on('data', (chunk) => {
        browserOutput = (browserOutput + String(chunk)).slice(-16_384)
    })
    browser.stderr.on('data', (chunk) => {
        browserLogs = (browserLogs + String(chunk)).slice(-16_384)
    })
    const browserFailure = async (message, cause) => {
        const [profileEntries, processStatus] = await Promise.all([
            readdir(profile).then(
                (entries) => entries.slice(0, 20),
                (error) => ({ error: error.code }),
            ),
            readFile(`/proc/${browser.pid}/status`, 'utf8').then(
                (status) => status.split('\n').filter((line) => /^(Name|State|Threads|VmRSS):/.test(line)),
                (error) => ({ error: error.code }),
            ),
        ])
        const state = {
            executable,
            version: versionDetails,
            elapsedMs: Math.round(performance.now() - started),
            pid: browser.pid,
            exit: browser.exitCode,
            signal: browser.signalCode,
            portState,
            profileEntries,
            processStatus,
        }
        return new Error(
            `${message}\nChromium startup state: ${JSON.stringify(state)}${browserOutput ? `\nChromium stdout (bounded tail):\n${browserOutput}` : ''}${browserLogs ? `\nChromium stderr (bounded tail):\n${browserLogs}` : ''}`,
            { cause },
        )
    }
    let socket
    let browserError
    browser.on('error', (error) => {
        browserError = error
    })
    try {
        let debuggingPort
        for (let attempt = 0; attempt < 200; attempt++) {
            const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(
                (value) => {
                    portState = { content: value.slice(0, 300) }
                    return value
                },
                (error) => {
                    portState = { error: error.code }
                    return ''
                },
            )
            if (content) {
                debuggingPort = Number(content.split('\n')[0])
                break
            }
            if (browserError)
                throw await browserFailure(
                    'Chromium is required for the browser probe; set CHROMIUM_PATH or use --ssr-only for explicitly limited coverage.',
                    browserError,
                )
            if (browser.exitCode !== null || browser.signalCode !== null)
                throw await browserFailure(
                    `Chromium exited before its debugging endpoint started (exit=${browser.exitCode}, signal=${browser.signalCode}).`,
                )
            await wait(50)
        }
        if (!debuggingPort) throw await browserFailure('Chromium debugging endpoint did not start.')
        console.log(
            'Public data Chromium ready:',
            JSON.stringify({ version: versionDetails, elapsedMs: Math.round(performance.now() - started) }),
        )
        const page = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, {
            method: 'PUT',
            signal: AbortSignal.timeout(15_000),
        })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.json()
            })
            .catch(async (error) => {
                throw await browserFailure('Chromium debugging endpoint could not open a page.', error)
            })
        socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Chromium CDP socket did not open.')), 15_000)
            socket.addEventListener(
                'open',
                () => {
                    clearTimeout(timer)
                    resolve()
                },
                { once: true },
            )
            socket.addEventListener(
                'error',
                () => {
                    clearTimeout(timer)
                    reject(new Error('Chromium CDP socket failed to open.'))
                },
                { once: true },
            )
        })
        let id = 0
        const pending = new Map()
        const diagnostics = []
        const recordDiagnostic = (item) => {
            diagnostics.push(item)
            if (diagnostics.length > 20) diagnostics.shift()
        }
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data))
            if (message.method === 'Log.entryAdded')
                recordDiagnostic({
                    kind: 'browser-log',
                    level: message.params.entry.level,
                    text: message.params.entry.text,
                })
            if (message.method === 'Runtime.exceptionThrown')
                recordDiagnostic({
                    kind: 'exception',
                    text:
                        message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
                })
            if (message.method === 'Network.loadingFailed')
                recordDiagnostic({
                    kind: 'request-failed',
                    error: message.params.errorText,
                    canceled: message.params.canceled,
                    blockedReason: message.params.blockedReason,
                    cors: message.params.corsErrorStatus,
                })
            if (!message.id) return
            const request = pending.get(message.id)
            pending.delete(message.id)
            clearTimeout(request?.timer)
            if (message.error) request?.reject(new Error(JSON.stringify(message.error)))
            else request?.resolve(message.result)
        })
        const rejectPending = (error) => {
            for (const request of pending.values()) {
                clearTimeout(request.timer)
                request.reject(error)
            }
            pending.clear()
        }
        socket.addEventListener('close', () => rejectPending(new Error('Chromium CDP socket closed.')))
        socket.addEventListener('error', () => rejectPending(new Error('Chromium CDP socket failed.')))
        const send = (method, params = {}) =>
            new Promise((resolve, reject) => {
                if (socket.readyState !== WebSocket.OPEN) {
                    reject(new Error('Chromium CDP socket is not open.'))
                    return
                }
                const requestId = ++id
                const timer = setTimeout(() => {
                    pending.delete(requestId)
                    reject(new Error(`Chromium CDP ${method} timed out.`))
                }, 15_000)
                pending.set(requestId, { resolve, reject, timer })
                socket.send(JSON.stringify({ id: requestId, method, params }))
            })
        await send('Page.enable')
        await send('Runtime.enable')
        await send('Log.enable')
        await send('Network.enable')
        await send('Page.navigate', { url: origin })
        for (let attempt = 0; attempt < 600; attempt++) {
            const result = await send('Runtime.evaluate', {
                expression: 'window.__siteAdminProbe',
                returnByValue: true,
            })
            if (result.result?.value?.done) return { ...result.result.value, browserDiagnostics: diagnostics }
            await wait(100)
        }
        throw new Error('Public data browser probe did not complete.')
    } finally {
        socket?.close()
        await stop(browser)
    }
}

/** Real packed Nuxt macro transformation, SSR payloads and Chromium hydration, with synthetic content only. */
export const verifyPublicDataConsumer = async (tarball, { browser = true } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), 'site-admin-public-data-consumer-'))
    const run = (command, args) => {
        const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        if (result.status !== 0)
            throw new Error(`${command} ${args.join(' ')} failed.\n${result.stdout}\n${result.stderr}`)
        return result.stdout
    }
    const put = async (path, source) => {
        await mkdir(resolvePath(directory, path, '..'), { recursive: true })
        await writeFile(join(directory, path), source)
    }
    const counts = Object.create(null)
    const requests = []
    const backend = createServer((request, response) => {
        response.setHeader('access-control-allow-origin', '*')
        const url = new URL(request.url, 'http://localhost')
        if (url.pathname === '/counts') {
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify(counts))
            return
        }
        const [, base, model, slug] = url.pathname.split('/')
        const locale = url.searchParams.get('locale') ?? ''
        const key = `${slug ?? 'list'}:${locale}`
        counts[key] = (counts[key] ?? 0) + 1
        requests.push({ key, closedBeforeResponse: false })
        const observation = requests.at(-1)
        response.once('close', () => {
            if (!response.writableEnded) observation.closedBeforeResponse = true
        })
        const document = (name) => ({
            data: {
                _siteAdmin: {
                    id: name,
                    model: 'posts',
                    slug: name,
                    locale,
                    path: `/posts/${name}`,
                    publishedAt: '2026-01-01',
                    revisionId: `revision-${name}`,
                },
                title: `${name}:${locale}`,
                body: { nodes: [['p', {}, 'Body']], frontmatter: {}, meta: {} },
            },
        })
        const finish = () => {
            if (response.destroyed) return
            response.setHeader('content-type', 'application/json')
            if (base !== 'content' || model !== 'posts') {
                response.statusCode = 404
                response.end('null')
                return
            }
            if (slug === 'error') {
                response.statusCode = 500
                response.end(JSON.stringify({ error: { code: 'SITE_ADMIN_TEST_ERROR', message: 'Synthetic error.' } }))
                return
            }
            if (slug === 'missing') {
                response.statusCode = 404
                response.end('null')
                return
            }
            response.end(JSON.stringify(slug ? document(slug) : locale === 'empty' ? [] : [document('list')]))
        }
        if (slug === 'slow' || slug === 'timeout') setTimeout(finish, 300)
        else finish()
    })
    let server
    const logs = []
    try {
        const backendOrigin = await listen(backend)
        await put(
            'package.json',
            JSON.stringify({
                private: true,
                type: 'module',
                dependencies: {
                    '@liria24/site-admin': `file:${resolvePath(tarball)}`,
                    nuxt: '4.6.0',
                    typescript: '7.0.2',
                    vue: '3.6.0-rc.9',
                    '@types/node': '26.6.4',
                },
                overrides: { vue: '$vue' },
            }),
        )
        console.log('Public data consumer: isolated packed installation')
        run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'])
        await applyNuxt46VerificationPatch(directory)
        await put(
            'nuxt.config.ts',
            `import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({
  devtools: false, modules: ['@liria24/site-admin/nuxt'],
  siteAdmin: { auth: false, i18n: false, llms: false, ogImage: false, robots: false, schemaOrg: false, seo: false, sitemap: false, routing: { enabled: false }, client: { basePath: '/content', origin: ${JSON.stringify(backendOrigin)} } },
})`,
        )
        await put(
            'site-admin.config.ts',
            `import { defineSiteAdminConfig, markdown, text } from '@liria24/site-admin'
export default defineSiteAdminConfig({ models: {
  posts: { fields: { title: text({ required: true }), body: markdown({ required: true }) } },
  private: { fields: { secret: text() }, public: false },
} })`,
        )
        await put(
            'app/app.vue',
            `<script setup lang="ts">
const slug = ref('ssr')
const locale = ref('ja')
const trigger = ref(0)
const entry = useSiteAdminEntry('posts', slug, { locale, watch: [locale, trigger], dedupe: 'defer' })
const duplicate = useSiteAdminEntry('posts', () => slug.value, { locale, dedupe: 'defer' })
const list = useSiteAdminList('posts', { locale })
const transformed = useSiteAdminList('posts', { locale: 'transformed', transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const timeout = useSiteAdminEntry('posts', 'timeout', { immediate: false, timeout: 25 })
// Direct native control distinguishes adapter behavior from native shared-key ownership.
const nuxtApp = useNuxtApp()
const nativeClient = useSiteAdminClient()
const nativeHandler = (_app: unknown, { signal }: { signal: AbortSignal }) => nativeClient.get('posts', slug.value, { signal, locale: 'native-ja' })
const nativeControl = useAsyncData(() => 'native-control:' + slug.value, nativeHandler, { dedupe: 'defer' })
const nativeDuplicate = useAsyncData(() => 'native-control:' + slug.value, nativeHandler, { dedupe: 'defer' })
const nativeSingle = useAsyncData(() => 'native-single:' + slug.value, (_app, { signal }) => nativeClient.get('posts', slug.value, { signal, locale: 'single-ja' }), { dedupe: 'defer' })
const batchSlug = ref('batch-first')
const batchLocale = ref('batch-ja')
const batch = useSiteAdminBatch(computed(() => ({
  catalog: { list: 'posts' }, featured: { entry: 'posts', slugOrId: batchSlug }, failed: { entry: 'posts', slugOrId: 'error' },
} as const)), {
  locale: batchLocale, dedupe: 'defer',
  transform: (items) => ({ ...items, count: items.catalog.data.length }),
  default: () => ({ catalog: { data: [], error: null }, featured: { data: null, error: null }, failed: { data: null, error: null }, count: 0 }),
})
await Promise.all([entry, duplicate, list, transformed, batch, nativeControl, nativeDuplicate, nativeSingle])
const initial = computed(() => ({ title: entry.data.value?.data.title, body: entry.data.value?.data.body.nodes, list: list.data.value?.length, transformed: transformed.data.value, batch: batch.data.value }))
onMounted(async () => {
  const checks: Record<string, unknown> = {}
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const state = () => ({
    slug: slug.value, locale: locale.value, isHydrating: nuxtApp.isHydrating,
    nativeSingle: { status: nativeSingle.status.value, data: nativeSingle.data.value, error: nativeSingle.error.value?.message },
    nativeControl: { status: nativeControl.status.value, data: nativeControl.data.value, error: nativeControl.error.value?.message },
    nativeDuplicate: { status: nativeDuplicate.status.value, data: nativeDuplicate.data.value, error: nativeDuplicate.error.value?.message },
    // Read-only native lifecycle diagnostics belong to this synthetic test, not the public library contract.
    nativeKeys: Object.entries(nuxtApp._asyncData).slice(-24).map(([key, item]) => {
      const data = item?.data.value
      return { key, deps: item?._deps, initialized: item?._init, status: item?.status.value,
        slug: data && typeof data === 'object' && 'slug' in data ? data.slug : undefined, pendingPromise: !!nuxtApp._asyncDataPromises[key],
        aborted: item?._abortController?.signal.aborted, abortReason: item?._abortController?.signal.reason ? String(item._abortController.signal.reason).slice(0, 512) : undefined,
      }
    }),
    entry: { status: entry.status.value, data: entry.data.value, error: entry.error.value?.message },
    duplicate: { status: duplicate.status.value, data: duplicate.data.value, error: duplicate.error.value?.message },
    list: { status: list.status.value, data: list.data.value, error: list.error.value?.message },
    batch: { slug: batchSlug.value, locale: batchLocale.value, status: batch.status.value, data: batch.data.value, error: batch.error.value?.message },
  })
  const until = async (stage: string, predicate: () => boolean) => {
    checks.stage = stage
    for (let index = 0; index < 300; index++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)) }
    throw new Error('Condition did not settle at ' + stage + '. State: ' + JSON.stringify(state()))
  }
  const getCounts = () => $fetch<Record<string, number>>(${JSON.stringify(`${backendOrigin}/counts`)})
  try {
    checks.stage = 'hydration'
    checks.versions = { nuxt: nuxtApp.versions.nuxt, vue: nuxtApp.versions.vue }
    checks.initial = initial.value
    checks.hydrationCounts = await getCounts()
    checks.hydrationState = state()
    check(entry.data.value?.data.title === 'ssr:ja', 'SSR entry must hydrate.')
    check(transformed.data.value[0] === 'list:transformed', 'SSR transform must hydrate.')
    check(batch.data.value.featured.data?.slug === 'batch-first' && batch.data.value.catalog.data.length === 1 && batch.data.value.count === 1, 'One batch state must hydrate named success data and native transform.')
    check(batch.data.value.failed.error?.status === 500 && batch.data.value.failed.data === null && !batch.error.value, 'Batch item failure must retain successes without a whole-state error.')
    check(!JSON.stringify(batch.data.value).includes('stack') && !JSON.stringify(batch.data.value).includes('cause'), 'Batch error DTO must not serialize stacks/causes.')
    slug.value = 'slow'
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    checks.slowState = state()
    slug.value = 'fast'
    await nextTick()
    checks.fastStartState = state()
    await until('entry slow-to-fast race', () => entry.data.value?.slug === 'fast' && entry.status.value === 'success')
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(entry.data.value?.slug === 'fast', 'Slow slug response must not overwrite the latest entry.')
    locale.value = 'en'
    await until('entry/list locale transition', () => entry.data.value?.locale === 'en' && list.status.value === 'success')
    checks.localeCounts = await getCounts()
    check(duplicate.data.value === entry.data.value, 'Identical native keys must share data.')
    const beforeRefresh = (await getCounts())['fast:en'] ?? 0
    await entry.refresh()
    check((await getCounts())['fast:en'] === beforeRefresh + 1, 'Refresh must use the native control.')
    entry.clear()
    check(entry.data.value === undefined && entry.status.value === 'idle' && !entry.error.value, 'Clear must use native default/status/error.')
    await entry.execute()
    check(entry.data.value?.slug === 'fast', 'Execute must refetch after clear.')
    trigger.value += 1
    await until('native entry watch', () => entry.status.value === 'success')
    await new Promise((resolve) => setTimeout(resolve, 30))
    checks.watchCounts = await getCounts()
    slug.value = 'missing'
    await until('entry 404', () => entry.status.value === 'success' && entry.data.value === null)
    check(!entry.error.value, '404 must be nullable data rather than error.')
    slug.value = 'error'
    await until('entry HTTP error', () => entry.status.value === 'error')
    check(!!entry.error.value, 'A failed HTTP response must remain in native error state.')
    locale.value = 'empty'
    await until('empty locale list', () => list.status.value === 'success' && list.data.value?.length === 0)
    await timeout.execute()
    check(timeout.status.value === 'error' && !!timeout.error.value, 'Native timeout must report an error.')
    batchSlug.value = 'slow'
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    batchSlug.value = 'batch-fast'
    batchLocale.value = 'batch-en'
    await until('batch slug/locale race', () => batch.status.value === 'success' && batch.data.value.featured.data?.slug === 'batch-fast' && batch.data.value.featured.data?.locale === 'batch-en')
    await new Promise((resolve) => setTimeout(resolve, 350))
    check(batch.data.value.featured.data?.slug === 'batch-fast', 'Late batch request must not overwrite the latest composite key.')
    const beforeBatchRefresh = await getCounts()
    await batch.refresh()
    const afterBatchRefresh = await getCounts()
    for (const key of ['list:batch-en', 'batch-fast:batch-en', 'error:batch-en']) check(afterBatchRefresh[key] === (beforeBatchRefresh[key] ?? 0) + 1, 'Native batch refresh must refresh every named request: ' + key)
    check(batch.data.value.failed.error?.status === 500 && batch.data.value.catalog.error === null, 'Refreshed batch must retain named partial-success semantics.')
    batch.clear()
    check(batch.data.value.count === 0 && batch.data.value.catalog.data.length === 0 && batch.status.value === 'idle', 'Batch clear must use the native default.')
    await batch.execute()
    check(batch.data.value.featured.data?.slug === 'batch-fast' && batch.data.value.count === 1, 'Batch execute must restore transformed named data.')
    checks.batchCounts = await getCounts()
    checks.stage = 'complete'
    checks.done = true
    ;(window as Window & { __siteAdminProbe?: unknown }).__siteAdminProbe = { done: true, checks }
  } catch (error) {
    checks.failureState = state()
    checks.failureCounts = await getCounts().catch((countsError: unknown) => ({ error: String(countsError) }))
    ;(window as Window & { __siteAdminProbe?: unknown }).__siteAdminProbe = { done: true, error: String(error), checks }
  }
})
</script>
<template><div id="initial">{{ JSON.stringify(initial) }}</div></template>`,
        )
        await put(
            'app/types.ts',
            `const entry = useSiteAdminEntry('posts', 'slug')
const title: string | undefined = entry.data.value?.data.title
const nodes: import('#comark').Node[] | undefined = entry.data.value?.data.body.nodes
const transformed = useSiteAdminList('posts', { transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const titles: string[] = transformed.data.value
// @ts-expect-error Unknown model names fail.
useSiteAdminEntry('missing', 'slug')
// @ts-expect-error Private models are unavailable.
useSiteAdminList('private')
const batch = useSiteAdminBatch({ catalog: { list: 'posts' }, featured: { entry: 'posts', slugOrId: 'slug' } }, {
  transform: (items) => ({ ...items, count: items.catalog.data.length }),
  default: () => ({ catalog: { data: [], error: null }, featured: { data: null, error: null }, count: 0 }),
})
const batchTitle: string | undefined = batch.data.value.featured.data?.data.title
const batchCount: number = batch.data.value.count
// @ts-expect-error Unknown batch models are unavailable.
useSiteAdminBatch({ invalid: { list: 'missing' } })
void [title, nodes, titles, batchTitle, batchCount]`,
        )
        console.log('Public data consumer: real Nuxt macro build and generated app types')
        run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'])
        run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.nuxt/tsconfig.app.json'])
        const portServer = createServer()
        const origin = await listen(portServer)
        await close(portServer)
        server = spawn(process.execPath, ['.output/server/index.mjs'], {
            cwd: directory,
            env: { ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        server.stdout.on('data', (chunk) => logs.push(String(chunk)))
        server.stderr.on('data', (chunk) => logs.push(String(chunk)))
        let html
        for (let attempt = 0; attempt < 200; attempt++) {
            const response = await fetch(origin, { signal: AbortSignal.timeout(15_000) }).catch(() => null)
            if (response?.ok) {
                html = await response.text()
                break
            }
            if (response) logs.push(await response.text())
            if (server.exitCode !== null) throw new Error(`Nuxt server exited.\n${logs.join('')}`)
            await wait(50)
        }
        assert.ok(html?.includes('ssr:ja'), `The factory must execute successfully during SSR.\n${logs.join('')}`)
        assert.equal(counts['ssr:ja'], 1, 'Identical SSR keys must deduplicate with native defer.')
        assert.equal(counts['list:ja'], 1)
        assert.ok(
            html.includes('batch-first:batch-ja') && html.includes('SITE_ADMIN_TEST_ERROR'),
            'SSR batch must serialize partial named results.',
        )
        assert.equal(counts['list:batch-ja'], 1)
        assert.equal(counts['batch-first:batch-ja'], 1)
        assert.equal(counts['error:batch-ja'], 1)
        if (!browser) {
            console.log(
                'Public data consumer passed: actual factory transform, generated types and SSR. Browser coverage was not requested.',
            )
            return
        }
        const result = await chromiumProbe(origin, directory)
        assert.equal(
            result.error,
            undefined,
            JSON.stringify({
                result,
                backendCounts: counts,
                requests: requests.slice(-40),
                serverLogs: logs.join('').slice(-16_384),
            }),
        )
        assert.equal(
            result.checks.hydrationCounts['ssr:ja'],
            2,
            'Browser SSR must hydrate without a second client entry fetch.',
        )
        assert.equal(
            result.checks.hydrationCounts['list:ja'],
            2,
            'Browser SSR must hydrate without a second client list fetch.',
        )
        assert.equal(
            result.checks.localeCounts['fast:en'],
            1,
            'Reactive locale key and native watch must not issue duplicate requests.',
        )
        assert.equal(result.checks.localeCounts['list:en'], 1)
        for (const key of ['list:batch-ja', 'batch-first:batch-ja', 'error:batch-ja']) {
            assert.equal(
                result.checks.hydrationCounts[key],
                2,
                'One SSR batch payload must hydrate without refetching: ' + key,
            )
        }
        assert.ok(
            requests.some((request) => request.key === 'slow:batch-ja' && request.closedBeforeResponse),
            'Composite-key cancellation must abort the batch HTTP transport.',
        )
        assert.ok(
            requests.some((request) => request.key === 'slow:ja' && request.closedBeforeResponse),
            'Native cancellation must abort the core HTTP transport.',
        )
        assert.ok(
            requests.some((request) => request.key === 'timeout:' && request.closedBeforeResponse),
            'Native timeout must abort the core HTTP transport.',
        )
        console.log(
            'Public data consumer passed: actual factory transform, SSR, hydration, dedupe, slug/locale races, batch partial success/refresh-all, controls, errors and timeout',
        )
    } finally {
        await stop(server)
        await close(backend)
        if (process.env.SITE_ADMIN_KEEP_PUBLIC_DATA_CONSUMER !== '1') await removePublicDataConsumer(directory)
        else console.log(`Public data consumer retained: ${directory}`)
    }
}

if (process.argv[1]?.endsWith('/public-data-consumer.mjs')) {
    if (!process.argv[2]) throw new Error('Pass the packed Site Admin tarball path.')
    await verifyPublicDataConsumer(process.argv[2], { browser: !process.argv.includes('--ssr-only') })
}
