import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { buildNuxt, loadNuxt } from '@nuxt/kit'

const fixture = fileURLToPath(new URL('./fixtures/nuxt/', import.meta.url))
await Promise.all([
    rm(fileURLToPath(new URL('./fixtures/nuxt/.nuxt/', import.meta.url)), { force: true, recursive: true }),
    rm(fileURLToPath(new URL('./fixtures/nuxt/.output/', import.meta.url)), { force: true, recursive: true }),
    rm(fileURLToPath(new URL('./fixtures/nuxt/.data/', import.meta.url)), { force: true, recursive: true }),
])

const nuxt = await loadNuxt({ cwd: fixture, dev: false, ready: true })
try {
    await buildNuxt(nuxt)
} finally {
    await nuxt.close()
}

const entry = fileURLToPath(new URL('./fixtures/nuxt/.output/server/index.mjs', import.meta.url))
await access(entry)

const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string')
            return reject(new Error('Unable to reserve a test port.'))
        probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
})
const output = []
const server = spawn(process.execPath, [entry], {
    cwd: fixture,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (chunk) => output.push(String(chunk)))
server.stderr.on('data', (chunk) => output.push(String(chunk)))

try {
    let response
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            response = await fetch(`http://127.0.0.1:${port}/api/content/settings`)
            break
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    if (!response?.ok || JSON.stringify(await response.json()) !== '[]') {
        throw new Error(`Nuxt public content probe failed.\n${output.join('')}`)
    }
    const management = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`)
    if (!management.headers.get('content-type')?.startsWith('text/html'))
        throw new Error('Nuxt registered management routes while auth was disabled.')
    const llms = await fetch(`http://127.0.0.1:${port}/llms.txt`)
    if (!llms.ok || !(await llms.text()).startsWith('# Site content')) {
        throw new Error('Nuxt llms.txt probe failed.')
    }
} finally {
    server.kill()
    await once(server, 'exit')
}
