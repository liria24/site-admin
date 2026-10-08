import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, rm, readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

import { buildNuxt, loadNuxt } from 'nuxt/kit'
import domain from './fixtures/nuxt/site-admin.config.ts'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { generateFixtureSQL } from './generate-fixture.mjs'

const fixture = fileURLToPath(new URL('./fixtures/nuxt/', import.meta.url))
process.env.SITE_ADMIN_TEST_DATABASE = fixture + '/.data/content.sqlite3'
const authSecret = 'site-admin-integration-test-secret-0000000000000000'
process.env.NUXT_BETTER_AUTH_SECRET = authSecret
process.env.NUXT_PUBLIC_SITE_URL = 'http://127.0.0.1:3000'
await Promise.all([
    rm(fileURLToPath(new URL('./fixtures/nuxt/.nuxt/', import.meta.url)), { force: true, recursive: true }),
    rm(fileURLToPath(new URL('./fixtures/nuxt/.output/', import.meta.url)), { force: true, recursive: true }),
    rm(fileURLToPath(new URL('./fixtures/nuxt/.data/', import.meta.url)), { force: true, recursive: true }),
])

// Generate source before native auth config inspection; applying SQL remains a separate application step.
const migrationSQL = await generateFixtureSQL(domain, fixture + '/.data/schema')
const devNuxt = await loadNuxt({ cwd: fixture, dev: true, ready: true })
try {
    if (
        await access(fixture + '/.data/content.sqlite3').then(
            () => true,
            () => false,
        )
    )
        throw new Error('Site Admin module setup must not open a SQLite database or apply migrations.')
} finally {
    await devNuxt.close()
}
await rm(fileURLToPath(new URL('./fixtures/nuxt/.nuxt/', import.meta.url)), { force: true, recursive: true })
const database = createDatabase(nodeSqlite({ path: fixture + '/.data/content.sqlite3' }))
await database.exec(migrationSQL)
await database.dispose()

const nuxt = await loadNuxt({ cwd: fixture, dev: false, ready: true })
try {
    await buildNuxt(nuxt)
} finally {
    await nuxt.close()
}

// Type-only generated imports must never pull common server config or AI actions into app assets.
const publicDirectory = fileURLToPath(new URL('./fixtures/nuxt/.output/public/', import.meta.url))
for (const name of await readdir(publicDirectory, { recursive: true })) {
    if (!/\.(?:js|json|html)$/u.test(name)) continue
    const source = await readFile(publicDirectory + '/' + name, 'utf8')
    if (source.includes('SITE_ADMIN_SERVER_ONLY_AI_SENTINEL') || source.includes('ignoredCommonStorage'))
        throw new Error(`Server-only common configuration leaked into public output: ${name}`)
}

const entry = fileURLToPath(new URL('./fixtures/nuxt/.output/server/index.mjs', import.meta.url))
await access(entry)

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
const server = spawn(process.execPath, [entry], {
    cwd: fixture,
    env: {
        ...process.env,
        HOST: '127.0.0.1',
        NUXT_BETTER_AUTH_SECRET: authSecret,
        NUXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
        PORT: String(port),
    },
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
    const seed = await fetch(`http://127.0.0.1:${port}/api/__seed`, { method: 'POST' })
    if (!seed.ok || !(await seed.json()).seeded) throw new Error(`Nuxt seed failed.\n${output.join('')}`)
    const management = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`)
    if (management.status !== 401 || (await management.json()).error?.code !== 'SITE_ADMIN_AUTH_REQUIRED') {
        throw new Error('Nuxt Better Auth integration did not reject an unauthenticated management request.')
    }
    const authSession = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`)
    if (!authSession.ok || (await authSession.json()) !== null)
        throw new Error('Nuxt Better Auth session endpoint probe failed.')
    const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email: 'editor@example.com', name: 'Editor', password: 'correct-horse-battery-staple' }),
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        method: 'POST',
    })
    if (!signup.ok) throw new Error(`Nuxt Better Auth sign-up failed: ${await signup.text()}`)
    const cookie = (signup.headers.getSetCookie?.() ?? [signup.headers.get('set-cookie')])
        .filter(Boolean)
        .map((value) => value.split(';')[0])
        .join('; ')
    const userDenied = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`, { headers: { cookie } })
    if (!userDenied.ok || Object.keys((await userDenied.json()).models).length !== 0) {
        throw new Error('The Better Auth user role received models in its descriptor.')
    }
    const userOperation = await fetch(`http://127.0.0.1:${port}/api/site-admin/entries?model=posts`, {
        headers: { cookie },
    })
    if (userOperation.status !== 403) throw new Error('The Better Auth user role received Site Admin permissions.')
    const hookDenied = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`, {
        headers: { cookie, 'x-site-admin-test-deny': '1' },
    })
    const deniedBody = await hookDenied.text()
    if (
        hookDenied.status !== 403 ||
        JSON.parse(deniedBody).error?.code !== 'SITE_ADMIN_FORBIDDEN' ||
        deniedBody.includes('PRIVATE_DENIAL')
    ) {
        throw new Error('Native authorization hook status/redaction regression.')
    }
    const editorModels = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`, {
        headers: { cookie, 'x-site-admin-test-role': 'editor' },
    })
    if (!editorModels.ok || Object.keys((await editorModels.json()).models).join(',') !== 'posts') {
        throw new Error('Nuxt custom role descriptor filtering failed.')
    }
    const adminModels = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`, {
        headers: { cookie, 'x-site-admin-test-role': 'admin' },
    })
    if (!adminModels.ok || Object.keys((await adminModels.json()).models).length !== 3) {
        throw new Error('Nuxt admin role integration failed.')
    }
    const routeProbe = await fetch(
        `http://127.0.0.1:${port}/api/content/_route?path=/ja/posts/%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF&locale=ja`,
    )
    if (!routeProbe.ok || (await routeProbe.json()).entry?.locale !== 'ja') {
        throw new Error('Nuxt localized public route API probe failed.')
    }
    const parallel = await Promise.all(
        ['admin', 'user', 'editor', 'user'].map(async (role) => {
            const parallelResponse = await fetch(`http://127.0.0.1:${port}/api/site-admin/models`, {
                headers: { cookie, 'x-site-admin-test-role': role },
            })
            return Object.keys((await parallelResponse.json()).models).length
        }),
    )
    if (String(parallel) !== '3,0,1,0')
        throw new Error('Native authorization contexts leaked between concurrent requests.')
    const background = await fetch(`http://127.0.0.1:${port}/api/__background`, { method: 'POST' })
    if (!background.ok || !Array.isArray((await background.json()).failed))
        throw new Error('Event-free native background runtime failed.')
    const page = await fetch(`http://127.0.0.1:${port}/ja/posts/%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF`)
    const html = await page.text()
    const pageChecks = {
        canonical: html.includes('rel="canonical"'),
        hreflang: html.includes('hreflang="en"'),
        lang: html.includes('lang="ja"'),
        ogImage: html.includes('og:image'),
        ok: page.ok,
        schema: html.includes('WebPage'),
        title: html.includes('<title>こんにちは'),
    }
    if (Object.values(pageChecks).includes(false)) {
        throw new Error(`Nuxt i18n/SEO/OG/Schema.org probe failed: ${JSON.stringify(pageChecks)}`)
    }
    const seoResponse = await fetch(`http://127.0.0.1:${port}/seo-probe`)
    const seoHtml = await seoResponse.text()
    if (
        !seoResponse.ok ||
        !seoHtml.includes('<title>SEO helper probe | Test</title>') ||
        !seoHtml.includes('content="Shared SEO description"') ||
        !/property="og:type"[^>]+content="article"/u.test(seoHtml) ||
        !/name="twitter:card"[^>]+content="summary"/u.test(seoHtml)
    ) {
        throw new Error(`Shared useSeo SSR probe failed: ${seoResponse.status} ${seoHtml.slice(0, 1000)}`)
    }
    const localizedSeoResponse = await fetch(`http://127.0.0.1:${port}/ja/seo-probe`)
    const localizedSeoHtml = await localizedSeoResponse.text()
    if (
        !localizedSeoResponse.ok ||
        !localizedSeoHtml.includes('<title>SEO helper probe</title>') ||
        !/name="robots"[^>]+content="noindex, follow"/u.test(localizedSeoHtml) ||
        localizedSeoHtml.includes('property="og:image"') ||
        localizedSeoHtml.includes('name="twitter:image"')
    ) {
        throw new Error(
            `Localized route useSeo clearing probe failed: ${localizedSeoResponse.status} ${localizedSeoHtml.slice(0, 1000)}`,
        )
    }
    const publicDataResponse = await fetch(`http://127.0.0.1:${port}/public-data-probe`)
    const publicDataHtml = await publicDataResponse.text()
    if (
        !publicDataResponse.ok ||
        !publicDataHtml.includes('id="entry-title">こんにちは') ||
        !publicDataHtml.includes('id="list-size">1') ||
        !publicDataHtml.includes('id="transformed-title">Hello') ||
        !publicDataHtml.includes('id="missing-entry">true')
    ) {
        throw new Error(
            `Native public AsyncData SSR probe failed: ${publicDataResponse.status} ${publicDataHtml.slice(0, 1000)}`,
        )
    }
    const redirect = await fetch(`http://127.0.0.1:${port}/go/external`, { redirect: 'manual' })
    if (redirect.status !== 302 || redirect.headers.get('location') !== 'https://example.com/destination') {
        throw new Error('Nuxt route middleware redirect probe failed.')
    }
    const sitemap = await fetch(`http://127.0.0.1:${port}/__sitemap__/ja.xml`)
    const sitemapXml = await sitemap.text()
    if (
        !sitemap.ok ||
        !sitemapXml.includes('<urlset') ||
        !sitemapXml.includes('/ja/posts/%E3%81%93') ||
        sitemapXml.includes('%25E3')
    ) {
        throw new Error('Nuxt sitemap integration probe failed.')
    }
    const llms = await fetch(`http://127.0.0.1:${port}/llms.txt`)
    if (!llms.ok || !(await llms.text()).startsWith('# Site content')) {
        throw new Error('Nuxt llms.txt probe failed.')
    }
} finally {
    // A startup failure may have emitted exit before cleanup. Preserve its diagnostic.
    if (server.exitCode === null && server.signalCode === null) {
        server.kill()
        await once(server, 'exit')
    }
}
