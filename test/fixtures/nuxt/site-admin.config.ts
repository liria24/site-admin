import { boolean, defineSiteAdminAuthorization, defineSiteAdminConfig, text, url } from '@liria24/site-admin'
import { Output } from 'ai'
import { z } from 'zod'
import { aiModel } from './server/ai-model.ts'

export default defineSiteAdminConfig({
    // Existing files.config.ts wins in full, including its sole storage selection.
    storage: { ignoredCommonStorage: { adapter: 'memory' } },
    assets: { maxUploadSize: 123 },
    ai: {
        models: { posts: { suggest: () => ({ data: { title: 'SITE_ADMIN_SERVER_ONLY_AI_SENTINEL' } }) } },
        actions: {
            proofread: {
                type: 'text-generation',
                model: aiModel,
                props: { content: z.string() },
                prompt: ({ content }) => 'SITE_ADMIN_SERVER_ONLY_AI_SENTINEL:' + content,
                output: Output.object({ schema: z.object({ content: z.string() }) }),
            },
            plain: {
                type: 'text-generation',
                model: aiModel,
                props: { content: z.string() },
                prompt: ({ content }) => content,
            },
        },
    },
    authorization: defineSiteAdminAuthorization({
        editor: { ai: ['proofread'], models: { posts: ['create', 'publish', 'readDraft', 'update'] } },
    }),
    database: async () => (await import('./server/database')).getSiteAdminDatabase(),
    tasks: { publishDue: true, syncAssets: true },
    seo: { titleTemplate: '%s | Global' },
    routeRules: {
        '/seo-probe': { seo: { titleTemplate: '%s | Test', type: 'article', twitterCard: 'summary' } },
        '/ja/seo-probe': { seo: { titleTemplate: null, robots: 'noindex, follow', image: false } },
    },
    models: {
        links: {
            fields: { destination: url({ required: true }), title: text({ required: true }) },
            publishing: false,
            route: { path: '/go/:slug', redirect: 'destination' },
        },
        posts: {
            fields: { description: text(), title: text({ required: true }) },
            localized: true,
            displayFields: { description: 'description', title: 'title' },
            route: true,
        },
        settings: { fields: { enabled: boolean() }, publishing: false },
    },
})
