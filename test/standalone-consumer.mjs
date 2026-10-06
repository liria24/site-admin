import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const verifyStandalone = async (tarball) => {
    const cwd = await mkdtemp(join(tmpdir(), 'site-admin-core-only-'))
    await writeFile(
        join(cwd, 'package.json'),
        JSON.stringify({
            private: true,
            type: 'module',
            dependencies: { '@liria24/site-admin': 'file:' + tarball.replaceAll('\\', '/'), typescript: '7.0.2' },
        }),
    )
    const run = (command, args) => {
        const result = spawnSync(command, args, {
            cwd,
            encoding: 'utf8',
            shell: process.platform === 'win32' && command === 'npm',
            maxBuffer: 8 * 1024 * 1024,
        })
        if (result.status !== 0) throw new Error(String(result.stdout) + String(result.stderr))
    }
    run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--omit=peer'])
    await writeFile(
        join(cwd, 'core.ts'),
        [
            "import { createSiteAdmin, handlePublicRequest, handleManagementRequest, type SiteAdminOptions } from '@liria24/site-admin/server'",
            "const options: SiteAdminOptions<{ principal: string }>['authorize'] = (_request, context) => ({ id: context?.principal ?? 'background' })",
            'void options; void createSiteAdmin; void handlePublicRequest; void handleManagementRequest',
        ].join('\n'),
    )
    await writeFile(
        join(cwd, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2024',
                module: 'Preserve',
                moduleResolution: 'Bundler',
                noEmit: true,
                strict: true,
                skipLibCheck: true,
            },
            include: ['core.ts'],
        }),
    )
    run('npm', ['exec', '--', 'tsc', '--noEmit'])
    await writeFile(
        join(cwd, 'probe.mjs'),
        [
            "import assert from 'node:assert/strict'",
            "import { createRequire } from 'node:module'",
            "import { createSiteAdmin, handlePublicRequest, handleManagementRequest } from '@liria24/site-admin/server'",
            'const require = createRequire(import.meta.url)',
            "assert.throws(() => require.resolve('nuxt/package.json'), { code: 'MODULE_NOT_FOUND' })",
            "assert.equal(typeof createSiteAdmin, 'function')",
            "const admin = { descriptor: { models: { posts: { public: true } } }, authorizeRequest: () => ({ id: 'admin' }), descriptorFor: () => ({ models: {} }) }",
            "const publicResponse = await handlePublicRequest(admin, new Request('http://localhost/api/content/models'))",
            'assert.equal(publicResponse.status, 200); assert.ok((await publicResponse.json()).models.posts)',
            "const management = await handleManagementRequest(admin, new Request('http://localhost/api/site-admin/models'))",
            "assert.equal(management.status, 200); assert.equal(management.headers.get('cache-control'), 'private, no-store')",
        ].join('\n'),
    )
    run(process.execPath, ['probe.mjs'])
    console.log('Standalone core: Nuxt absent; packed types and Web HTTP APIs verified.')
}
