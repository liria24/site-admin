import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineSiteAdminConfig, file, text } from '../packages/site-admin/dist/index.js'
import { generateFixtureSQL } from './generate-fixture.mjs'

const run = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/cloudflare/', import.meta.url))
const cli = fileURLToPath(new URL('../node_modules/cf/bin/cf', import.meta.url))
// cf resolves the declared bundler within the fixture rather than its parent workspace.
await symlink(
    fileURLToPath(new URL('../node_modules/', import.meta.url)),
    fixture + '/node_modules',
    process.platform === 'win32' ? 'junction' : 'dir',
).catch((error) => {
    if (error.code !== 'EEXIST') throw error
})
await rm(fileURLToPath(new URL('./fixtures/cloudflare/.wrangler/', import.meta.url)), { force: true, recursive: true })
const migrations = fixture + '/.data/wrangler-migrations'
await mkdir(migrations, { recursive: true })
await writeFile(
    migrations + '/0001_initial.sql',
    await generateFixtureSQL(
        defineSiteAdminConfig({
            models: { posts: { fields: { attachment: file(), title: text({ required: true }) }, route: true } },
        }),
        fixture + '/.data/schema',
    ),
)
await run(
    process.execPath,
    [
        '--input-type=module',
        '-e',
        // cf beta.7 leaves local runtime handles open on Linux after completing the command.
        "await import('node:url').then(({ pathToFileURL }) => import(pathToFileURL(process.argv[1]).href)); process.exit(process.exitCode ?? 0)",
        cli,
        'd1',
        'migrations',
        'apply',
        '00000000-0000-4000-8000-000000000001',
        '--local',
        '--persist-to',
        fixture + '/.wrangler/state',
        '--dir',
        migrations,
    ],
    {
        cwd: fixture,
        timeout: 60000,
    },
)
console.log('Applied the local D1 fixture migration with cf.')

const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a test port.'))
        probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
})
const output = []
// cf beta.7 directly spawns a .js delegate, which fails with EFTYPE on Windows.
const dev =
    process.platform === 'win32'
        ? [
              fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
              'dev',
              '--experimental-new-config',
          ]
        : [cli, 'dev']
const worker = spawn(process.execPath, [...dev, '--port', String(port)], {
    cwd: fixture,
    stdio: ['ignore', 'pipe', 'pipe'],
})
worker.stdout.on('data', (chunk) => output.push(String(chunk)))
worker.stderr.on('data', (chunk) => output.push(String(chunk)))

try {
    let response
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
            break
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    response = response?.ok && (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(30000) }))
    const result = response && (await response.json())
    if (!response?.ok || !result?.conflict || result.entries?.[0]?.data?.title !== 'D1') {
        throw new Error(`Cloudflare D1 CRUD/publish probe failed.\n${JSON.stringify(result)}\n${output.join('')}`)
    }
    const rollback = await (await fetch(`http://127.0.0.1:${port}/rollback`)).json()
    if (!rollback.rolledBack) throw new Error('Cloudflare D1 batch did not roll back atomically.')
    const reorder = await (await fetch(`http://127.0.0.1:${port}/reorder`)).json()
    if (!reorder.conflict || !reorder.unchanged || reorder.generation !== 1 || String(reorder.sorted) !== '0,1')
        throw new Error(`D1 reorder failed: ${JSON.stringify(reorder)}`)
    const bytes = new Uint8Array(11 * 1024 * 1024).fill(42)
    const upload = await (
        await fetch(`http://127.0.0.1:${port}/upload`, {
            method: 'POST',
            body: bytes,
            signal: AbortSignal.timeout(30000),
            headers: { 'x-upload-size': String(bytes.length) },
        })
    ).json()
    if (upload.asset?.state !== 'ready' || upload.size !== bytes.length || !upload.asset.checksum)
        throw new Error(`R2 streaming upload failed: ${JSON.stringify(upload)}`)
    const missing = await fetch(`http://127.0.0.1:${port}/missing-binding`)
    if (missing.status !== 500 || !String((await missing.json()).error)) {
        throw new Error('Cloudflare D1 missing-binding probe did not fail closed.')
    }
    const alias = await (await fetch(`http://127.0.0.1:${port}/alias`)).json()
    if (!alias.rejected) throw new Error('Same R2 bucket aliases were accepted as private/public storage.')
    const separated = await (
        await fetch(`http://127.0.0.1:${port}/separation`, {
            method: 'POST',
            body: bytes,
            signal: AbortSignal.timeout(30000),
            headers: { 'x-upload-size': String(bytes.length) },
        })
    ).json()
    if (
        !separated.privateBefore ||
        separated.publicBefore !== 0 ||
        separated.copiedBytes !== bytes.length ||
        !separated.cleared ||
        !separated.retained ||
        !separated.deleted
    )
        throw new Error(`D1/R2 separateDrafts failed: ${JSON.stringify(separated)}`)
} catch (error) {
    console.error(output.join(''))
    throw error
} finally {
    if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, 'exit')
        const forceExit = setTimeout(() => worker.kill('SIGKILL'), 5000)
        worker.kill()
        await exited
        clearTimeout(forceExit)
    }
}
