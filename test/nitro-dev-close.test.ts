import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createDevServer, createNitro } from 'nitropack'
import { expect, it } from 'vitest'
import { stopNitroDevReloadOnClose } from '../packages/site-admin/src/nuxt/dev-close'

it('closes active dev workers and ignores a build that completes after shutdown', async () => {
    await mkdir('.tmp', { recursive: true })
    const fixture = await mkdtemp(join(process.cwd(), '.tmp/nitro-close-'))
    const output = join(fixture, 'server')
    await mkdir(output)
    const pipe =
        process.platform === 'win32' ? '\\\\.\\pipe\\site-admin-nitro-close-' + randomUUID() : join(fixture, 'socket')
    let connections = 0
    const ipc = createServer((socket) => {
        connections++
        socket.on('close', () => connections--)
    })
    await new Promise<void>((resolve, reject) => {
        ipc.once('error', reject)
        ipc.listen(pipe, resolve)
    })
    await writeFile(
        join(output, 'index.mjs'),
        [
            "import { createConnection } from 'node:net'",
            "import { parentPort } from 'node:worker_threads'",
            'const socket = createConnection(' + JSON.stringify(pipe) + ')',
            "socket.on('error', () => {})",
            "parentPort.on('message', message => { if (message.event === 'shutdown') socket.end() })",
        ].join('\n'),
    )
    const nitro = await createNitro({
        rootDir: fixture,
        dev: true,
        preset: 'node-server',
        compatibilityDate: '2026-10-06',
        output: { dir: fixture, serverDir: output },
    })
    stopNitroDevReloadOnClose(nitro)
    const server = createDevServer(nitro)
    let reloads = 0
    nitro.hooks.hook('dev:reload', () => {
        reloads++
    })
    try {
        await nitro.hooks.callHook('dev:reload')
        await expect.poll(() => connections).toBe(1)
        expect(reloads).toBe(1)
        await nitro.close()
        await expect.poll(() => connections).toBe(0)
        // Replay the late Rollup BUNDLE_END seen during the Windows Nuxt restart.
        await nitro.hooks.callHook('dev:reload')
        expect(reloads).toBe(1)
        await new Promise<void>((resolve, reject) => ipc.close((error) => (error ? reject(error) : resolve())))
    } finally {
        await server.close()
        if (ipc.listening) await new Promise<void>((resolve) => ipc.close(() => resolve()))
        await nitro.close()
    }
})
