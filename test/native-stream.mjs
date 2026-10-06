import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNuxt, loadNuxt } from 'nuxt/kit'

const platform = process.argv[2] ?? 'node'
if (!['node', 'cloudflare'].includes(platform)) throw new Error('Unknown native stream platform.')
const workspace = fileURLToPath(new URL('../', import.meta.url))
await mkdir(join(workspace, '.tmp'), { recursive: true })
const fixture = await mkdtemp(join(workspace, '.tmp/native-stream-'))
await mkdir(join(fixture, 'server/api'), { recursive: true })
await mkdir(join(fixture, 'server/middleware'), { recursive: true })
await mkdir(join(fixture, 'server/plugins'), { recursive: true })
await writeFile(
    join(fixture, 'nuxt.config.ts'),
    [
        "import { defineNuxtConfig } from 'nuxt/config'",
        "import { transformNitroCloudflareRequest } from '@liria24/site-admin/runtime/nitro2'",
        'export default defineNuxtConfig({ devtools: { enabled: false }, nitro: {',
        'preset: ' + JSON.stringify(platform === 'cloudflare' ? 'cloudflare-module' : 'node-server') + ',',
        "rollupConfig: { plugins: [{ name: 'native-stream-input', transform: transformNitroCloudflareRequest }] }",
        '} })',
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/plugins/input.ts'),
    [
        "import { defineNitroPlugin } from 'nitropack/runtime'",
        "import { captureNitroRequest } from '@liria24/site-admin/runtime/nitro2'",
        "export default defineNitroPlugin((app) => { app.hooks.hook('request', (event) => captureNitroRequest(event, '/api', true)) })",
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/middleware/headers.ts'),
    [
        "import { defineEventHandler } from 'nuxt/server'",
        "export default defineEventHandler((event) => { void event.req.headers.get('x-stream-key') })",
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/progress.ts'),
    'export const progress = new Map<string, { total: number; complete: boolean; failed: boolean }>()\n',
)
await writeFile(
    join(fixture, 'server/api/assets.post.ts'),
    [
        "import { defineEventHandler } from 'nuxt/server'",
        "import { progress } from '../progress'",
        'export default defineEventHandler(async (event) => {',
        "const key = event.req.headers.get('x-stream-key')!",
        'const state = { total: 0, complete: false, failed: false }; progress.set(key, state)',
        'const reader = event.req.body!.getReader()',
        'try { while (true) { const chunk = await reader.read(); if (chunk.done) break; state.total += chunk.value.byteLength }',
        'state.complete = true; return Response.json(state)',
        '} catch { state.failed = true; return Response.json(state, { status: 400 }) }',
        'finally { reader.releaseLock() }',
        '})',
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/api/progress.ts'),
    [
        "import { defineEventHandler, getQuery } from 'nuxt/server'",
        "import { progress } from '../progress'",
        'export default defineEventHandler((event) => Response.json(progress.get(String(getQuery(event).key)) ?? null))',
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/api/response.get.ts'),
    [
        "import { defineEventHandler } from 'nuxt/server'",
        'export default defineEventHandler(() => {',
        'const headers = new Headers({ location: "/destination" })',
        'headers.append("set-cookie", "first=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/")',
        'headers.append("set-cookie", "second=two; Path=/; HttpOnly")',
        'return new Response(null, { status: 302, headers })',
        '})',
    ].join('\n'),
)
await writeFile(
    join(fixture, 'server/api/json.post.ts'),
    [
        "import { defineEventHandler } from 'nuxt/server'",
        'export default defineEventHandler(async (event) => Response.json(await event.req.json()))',
    ].join('\n'),
)
const nuxt = await loadNuxt({ cwd: fixture, dev: false, ready: true })
try {
    await buildNuxt(nuxt)
} finally {
    await nuxt.close()
}
const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') return reject(new Error('Missing probe port.'))
        probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
})
let args
if (platform === 'cloudflare') {
    const config = join(fixture, 'wrangler.stream.json')
    await writeFile(
        config,
        JSON.stringify({
            name: 'site-admin-native-stream-test',
            main: '.output/server/index.mjs',
            compatibility_date: '2026-07-30',
            compatibility_flags: ['nodejs_compat'],
        }),
    )
    args = [
        join(workspace, 'node_modules/wrangler/bin/wrangler.js'),
        'dev',
        '--local',
        '--config',
        config,
        '--port',
        String(port),
    ]
} else args = [join(fixture, '.output/server/index.mjs')]
const output = []
const child = spawn(process.execPath, args, {
    cwd: fixture,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => output.push(String(chunk)))
child.stderr.on('data', (chunk) => output.push(String(chunk)))
const origin = 'http://127.0.0.1:' + port
try {
    let ready = false
    for (let attempt = 0; attempt < 400; attempt++) {
        if (child.exitCode !== null) break
        try {
            await fetch(origin + '/api/progress?key=ready')
            ready = true
            break
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    if (!ready) throw new Error('Native stream server did not start.\n' + output.join(''))
    const json = await fetch(origin + '/api/json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'native JSON' }),
    })
    if (!json.ok || (await json.json()).value !== 'native JSON')
        throw new Error('Native JSON middleware/body regression.')
    const redirect = await fetch(origin + '/api/response', { redirect: 'manual' })
    if (
        redirect.status !== 302 ||
        redirect.headers.get('location') !== '/destination' ||
        redirect.headers.getSetCookie().length !== 2 ||
        (await redirect.text()) !== ''
    )
        throw new Error('Native Response redirect/multiple-cookie regression.')
    const head = await fetch(origin + '/api/progress?key=ready', { method: 'HEAD' })
    if (!head.ok || (await head.text()) !== '') throw new Error('Native HEAD body regression.')
    let release
    const continueBody = new Promise((resolve) => {
        release = resolve
    })
    let chunks = 0
    const body = new ReadableStream({
        async pull(controller) {
            if (chunks++ === 0) controller.enqueue(new Uint8Array(8192).fill(42))
            else {
                await continueBody
                controller.enqueue(new Uint8Array(8192).fill(24))
                controller.close()
            }
        },
    })
    const result = fetch(origin + '/api/assets', {
        method: 'POST',
        headers: { 'x-stream-key': 'delayed' },
        body,
        duplex: 'half',
        signal: AbortSignal.timeout(15000),
    })
    result.catch(() => {})
    let early
    try {
        for (let attempt = 0; attempt < 100; attempt++) {
            early = await (await fetch(origin + '/api/progress?key=delayed')).json()
            if (early?.total === 8192) break
            await new Promise((resolve) => setTimeout(resolve, 30))
        }
        if (early?.total !== 8192 || early.complete || early.failed) {
            throw new Error('Native Request body buffered until producer completion: ' + JSON.stringify(early))
        }
    } finally {
        release()
    }
    const response = await result
    const final = await response.json()
    if (!response.ok || final.total !== 16384 || !final.complete || final.failed)
        throw new Error('Native stream byte/completion mismatch.')
    console.log(
        'Native stream verified on ' +
            platform +
            ': first chunk reached the sink before the producer completed, including native header middleware.',
    )
} catch (error) {
    console.error(output.join(''))
    throw error
} finally {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        const force = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.kill()
        await exited
        clearTimeout(force)
    }
}
