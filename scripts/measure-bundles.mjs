// Adapted from liria24/insight-ts/packages/insight-ts/scripts/measure-bundles.ts (MIT).
// Copyright (c) 2026 Liria. Permission and warranty terms are in LICENSE.
/* eslint-disable no-await-in-loop -- entries are measured sequentially to bound peak memory */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const scenarios = [
    {
        name: 'Core',
        entry: 'dist/index.js',
        target: 'node',
    },
    {
        name: 'Client',
        entry: 'dist/client.js',
        target: 'browser',
    },
    {
        name: 'Forms',
        entry: 'dist/form.js',
        target: 'browser',
    },
    {
        name: 'Nuxt module',
        entry: 'dist/nuxt.js',
        target: 'node',
    },
    {
        name: 'Server',
        entry: 'dist/server.js',
        target: 'node',
    },
    {
        name: 'Adapter',
        entry: 'dist/adapter.js',
        target: 'node',
    },
    {
        name: 'AI',
        entry: 'dist/ai.js',
        target: 'node',
    },
    {
        name: 'SEO',
        entry: 'dist/seo.js',
        target: 'node',
    },
]
const cliArguments = process.argv.slice(2)
const output = option('--output')

if (cliArguments[0] === '--compare') {
    const base = await readReport(required(cliArguments[1], 'base report'))
    const head = await readReport(required(cliArguments[2], 'head report'))
    await emit(compare(base, head), output)
} else {
    const packageRoot = resolve(required(option('--package-root'), '--package-root'))
    await emit(JSON.stringify(await measure(packageRoot), null, 2) + '\n', output)
}

async function measure(packageRoot) {
    const root = await mkdtemp(join(tmpdir(), 'package-bundles-'))
    try {
        const packed = await run(
            [process.execPath, 'pm', 'pack', '--destination', root, '--ignore-scripts', '--quiet'],
            packageRoot,
        )
        const filename = basename(packed.trim())
        if (!filename.endsWith('.tgz')) throw new Error('bun pm pack did not report a tarball')
        await run(['tar', '-xzf', join(root, filename), '-C', root], packageRoot)
        const directory = join(root, 'package')
        const files = await readFiles(directory)
        const javascript = files.filter((file) => /\.(?:c|m)?js$/.test(file.name))
        const declarations = files.filter((file) => /\.d\.(?:c|m)?ts$/.test(file.name))
        if (!javascript.length || !declarations.length) throw new Error('Packed build output is missing')
        const results = [
            size(
                'Published files',
                files.map((file) => file.bytes),
            ),
            size(
                'Distributed JavaScript',
                javascript.map((file) => file.bytes),
            ),
            size(
                'Type declarations',
                declarations.map((file) => file.bytes),
            ),
        ]
        const assets = files.filter((file) => file.name.startsWith('dist/devtools/client/'))
        if (!assets.length) throw new Error('Packed DevTools client output is missing')
        results.push(
            size(
                'DevTools client',
                assets.map((file) => file.bytes),
            ),
        )
        for (const scenario of scenarios) {
            // Measure the archive's files, with the same head-owned bundler/options for both revisions.
            const built = await Bun.build({
                entrypoints: [join(directory, scenario.entry)],
                target: scenario.target,
                packages: 'external',
                external: ['#*'],
                minify: true,
            })
            if (!built.success) throw new AggregateError(built.logs, 'Packed entry bundle failed')
            results.push(
                size(
                    scenario.name,
                    await Promise.all(built.outputs.map(async (file) => Buffer.from(await file.arrayBuffer()))),
                ),
            )
        }
        return { version: 1, results }
    } finally {
        await rm(root, { force: true, recursive: true })
    }
}

async function readFiles(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    const groups = await Promise.all(
        entries.map(async (entry) => {
            const name = prefix + entry.name
            const path = join(directory, entry.name)
            if (entry.isDirectory()) return readFiles(path, name + '/')
            if (!entry.isFile()) throw new Error('Unexpected non-file in package: ' + name)
            return [{ name, bytes: await readFile(path) }]
        }),
    )
    return groups.flat().toSorted((left, right) => left.name.localeCompare(right.name))
}

function size(name, files) {
    return {
        gzip: files.reduce((total, file) => total + gzipSync(file).byteLength, 0),
        name,
        raw: files.reduce((total, file) => total + file.byteLength, 0),
    }
}

function compare(base, head) {
    const baseByName = new Map(base.results.map((result) => [result.name, result]))
    const headByName = new Map(head.results.map((result) => [result.name, result]))
    const names = new Set([...baseByName.keys(), ...headByName.keys()])
    const rows = [...names].map((name) => {
        const previous = baseByName.get(name)
        const current = headByName.get(name)
        return (
            '| ' +
            [
                name,
                bytes(previous?.raw ?? 0),
                bytes(current?.raw ?? 0),
                delta(previous?.raw ?? 0, current?.raw ?? 0),
                bytes(previous?.gzip ?? 0),
                bytes(current?.gzip ?? 0),
                delta(previous?.gzip ?? 0, current?.gzip ?? 0),
            ].join(' | ') +
            ' |'
        )
    })
    return `## Package and entry bundle sizes

| measurement | base raw | PR raw | Δ raw | base gzip | PR gzip | Δ gzip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

Both revisions are built with frozen lockfiles and measured from \`bun pm pack --ignore-scripts\` archives using the same script and bundler.
Published-file gzip is summed per file. Entry bundles are minified package code with dependencies, peers and framework virtual imports external; they are not complete application sizes.
Size changes are informational; existing package and consumer checks remain blocking.
`
}

function bytes(value) {
    return `${value} B (${(value / 1024).toFixed(1)} KiB)`
}

function delta(base, head) {
    const change = head - base
    if (change === 0) return '—'
    const formatted = Math.abs(change) < 1024 ? `${Math.abs(change)} B` : bytes(Math.abs(change))
    const percent = base === 0 ? '' : ` (${change > 0 ? '+' : ''}${((change / base) * 100).toFixed(1)}%)`
    return `${change > 0 ? '+' : '-'}${formatted}${percent}`
}

async function run(command, cwd) {
    const child = Bun.spawn(command, { cwd, stderr: 'pipe', stdout: 'pipe' })
    const [code, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ])
    if (code !== 0) throw new Error(`${command.join(' ')} failed\n${stderr || stdout}`)
    return stdout
}

function option(name) {
    const index = cliArguments.indexOf(name)
    return index === -1 ? undefined : cliArguments[index + 1]
}

function required(value, name) {
    if (!value) throw new Error('Missing ' + name)
    return value
}

async function emit(value, path) {
    if (path) await writeFile(path, value)
    else process.stdout.write(value)
}

async function readReport(path) {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (
        value?.version !== 1 ||
        !Array.isArray(value.results) ||
        !value.results.length ||
        !value.results.every(
            (result) =>
                typeof result?.name === 'string' &&
                Number.isFinite(result.raw) &&
                result.raw >= 0 &&
                Number.isFinite(result.gzip) &&
                result.gzip >= 0,
        )
    ) {
        throw new Error('Invalid bundle report: ' + path)
    }
    return value
}
