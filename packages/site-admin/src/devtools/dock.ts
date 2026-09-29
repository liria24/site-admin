import { fileURLToPath } from 'node:url'
import { NUXT_DEVTOOLS_GROUP_ID, onDevtoolsReady } from '@nuxt/devtools-kit'
import type { Nuxt } from '@nuxt/schema'
import { defineDevframe, defineRpcFunction } from 'devframe'
import { createEmbedded } from 'devframe/adapters/embedded'
import { DEVTOOLS_PATH } from './index'

export const setupDock = (nuxt: Nuxt): void => {
    onDevtoolsReady(async (context) => {
        const clientAssets = fileURLToPath(new URL('./client', import.meta.url))
        await createEmbedded(
            defineDevframe({
                id: 'site-admin',
                name: 'Site Admin',
                version: '0.0.0',
                packageName: '@liria24/site-admin',
                homepage: 'https://github.com/liria24/site-admin',
                description: 'Read-only Site Admin runtime diagnostics.',
                importMetaUrl: import.meta.url,
                clientAssets,
                async setup(frame) {
                    await frame.host.mountConnectionMeta?.(DEVTOOLS_PATH)
                    frame.views.hostStatic(DEVTOOLS_PATH, clientAssets)
                    const diagnostics = frame.diagnostics.defineDiagnostics({
                        codes: {
                            SITE_ADMIN_INSPECTION_FAILED: {
                                why: 'The authenticated runtime snapshot could not be read.',
                                fix: 'Sign in with system.diagnostics permission; generate and explicitly apply pending Drizzle migrations.',
                            },
                        },
                    })
                    frame.diagnostics.register(diagnostics)
                    let reported = false
                    frame.scope('site-admin').rpc.register(
                        defineRpcFunction({
                            name: 'report-failure',
                            type: 'event',
                            handler() {
                                if (reported) return
                                reported = true
                                diagnostics.SITE_ADMIN_INSPECTION_FAILED({}, { method: 'error' })
                                void context.messages.add({
                                    id: 'site-admin:inspection',
                                    message: 'Site Admin inspection failed',
                                    description: 'Check authentication and database migrations.',
                                    level: 'error',
                                    category: 'site-admin',
                                    labels: ['site-admin'],
                                    notify: true,
                                })
                            },
                        }),
                    )
                },
            }),
            { ctx: context },
        )
        context.docks.register({
            id: 'site-admin',
            title: 'Site Admin',
            icon: 'ph:database',
            type: 'iframe',
            url: DEVTOOLS_PATH,
            groupId: NUXT_DEVTOOLS_GROUP_ID,
        })
        context.commands.register({
            id: 'site-admin:open',
            title: 'Site Admin: Open',
            category: 'tools',
            handler: () => context.docks.activate('site-admin'),
        })
        for (const [method, title] of [
            ['refresh', 'Refresh'],
            ['copy-diagnostics', 'Copy Diagnostics'],
        ] as const) {
            context.commands.register({
                id: `site-admin:${method}`,
                title: `Site Admin: ${title}`,
                category: 'tools',
                handler: () =>
                    context.scope('site-admin').rpc.broadcast({ method, args: [], optional: true, event: true }),
            })
        }
    }, nuxt)
}
