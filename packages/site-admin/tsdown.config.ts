import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { moduleMeta } from './src/meta.ts'

const manifest: { version: string } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig([
    {
        attw: { level: 'error', profile: 'esm-only' },
        clean: true,
        copy: [
            { from: '../../README.md', to: '.' },
            { from: 'src/devtools/client/index.html', to: 'dist/devtools/client' },
        ],
        deps: {
            dts: { neverBundle: true },
            neverBundle: true,
            onlyImport: [
                'nuxt',
                '@nuxt/schema',
                '@nuxtjs/better-auth',
                '@better-auth/drizzle-adapter',
                '@standard-schema/spec',
                '@tanstack/vue-form',
                'better-auth',
                'comark',
                'comark-content',
                'drizzle-orm',
                'drizzle-kit',
                'devframe',
                '@nuxt/devtools-kit',
                'files-sdk',
                'h3',
                'jiti',
                'nuxt-files-sdk',
                'nuxt-llms',
                'node:path',
                'node:crypto',
                'node:stream',
                'node:url',
                'node:fs/promises',
                'node:fs',
                'node:util',
                'node:module',
                'rou3',
                'vue',
            ],
        },
        dts: true,
        entry: {
            adapter: 'src/adapter.ts',
            'adapters/drizzle': 'src/adapters/drizzle.ts',
            ai: 'src/ai.ts',
            client: 'src/client.ts',
            cli: 'src/cli.ts',
            generate: 'src/generate.ts',
            form: 'src/form.ts',
            index: 'src/index.ts',
            nuxt: 'src/nuxt.ts',
            'nuxt/server': 'src/nuxt/server.ts',
            'runtime/nitro2': 'src/runtime/nitro2.ts',
            'runtime/database-middleware': 'src/runtime/database-middleware.ts',
            'devtools/index': 'src/devtools/index.ts',
            'devtools/dock': 'src/devtools/dock.ts',
            'runtime/devtools-snapshot': 'src/runtime/devtools-snapshot.ts',
            server: 'src/server/index.ts',
            'runtime/management-handler': 'src/runtime/management-handler.ts',
            'runtime/public-handler': 'src/runtime/public-handler.ts',
        },
        exports: false,
        format: ['esm'],
        platform: 'neutral',
        publint: true,
        sourcemap: false,
        unbundle: true,
        plugins: [
            {
                name: 'nuxt-module-metadata',
                generateBundle() {
                    this.emitFile({
                        type: 'asset',
                        fileName: 'module.json',
                        source: JSON.stringify({ ...moduleMeta, version: manifest.version }, null, 2) + '\n',
                    })
                },
            },
        ],
    },
    {
        entry: { app: 'src/devtools/client/app.ts' },
        outDir: 'dist/devtools/client',
        format: 'esm',
        platform: 'browser',
        dts: false,
        clean: false,
        minify: true,
        sourcemap: false,
        deps: {
            alwaysBundle: [/^(?:birpc|devframe|nostics|p-map|ufo)(?:\/|$)/u],
            onlyBundle: [/^(?:birpc|devframe|nostics|p-map|ufo)(?:\/|$)/u],
        },
    },
])
