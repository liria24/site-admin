import { boolean, defineSiteAdminConfig, markdown, text, url } from '@liria24/site-admin'
import { Output } from 'ai'
import { z } from 'zod'
import { aiModel } from './server/ai-model.ts'

export default defineSiteAdminConfig({
    // Existing files.config.ts wins in full, including its sole storage selection.
    storage: { ignoredCommonStorage: { adapter: 'memory' } },
    assets: { maxUploadSize: 123 },
    ai: {
        actions: {
            proofread: {
                type: 'text-generation',
                model: aiModel,
                input: z.object({ content: z.string() }).strict(),
                prompt: ({ content }) => 'SITE_ADMIN_SERVER_ONLY_AI_SENTINEL:' + content,
                output: Output.object({ schema: z.object({ content: z.string() }) }),
            },
            plain: {
                type: 'text-generation',
                model: aiModel,
                input: z.object({ content: z.string() }).strict(),
                prompt: ({ content }) => content,
            },
        },
    },
    authorization: {
        roles: {
            editor: { ai: ['proofread'], models: { posts: ['create', 'publish', 'readDraft', 'update'] } },
        },
    },
    tasks: { publishDue: true, syncAssets: true },
    seo: { titleTemplate: '%s | Global' },
    routeRules: {
        '/seo-probe': {
            seo: {
                title: 'SEO helper probe',
                description: 'Shared SEO description',
                image: { component: 'Default.takumi' },
                titleTemplate: '%s | Test',
                type: 'article',
                twitterCard: 'summary',
            },
        },
        '/ja/seo-probe': {
            seo: {
                title: 'SEO helper probe',
                description: 'Shared SEO description',
                titleTemplate: null,
                robots: 'noindex, follow',
                image: false,
            },
        },
    },
    models: {
        links: {
            fields: {
                slug: text({ i18n: true }),
                destination: url({ required: true }),
                title: text({ required: true, i18n: true }),
            },
            publishing: false,
            route: { path: '/go/:slug', redirect: 'destination' },
        },
        posts: {
            meta: ({ t }) => ({ label: t('entry'), plural: t('entries'), editor: 'markdown' }),
            fields: {
                slug: text({ i18n: true }),
                description: text({ i18n: true }),
                title: text({ required: true, i18n: true, label: ({ t }) => t('title') }),
                body: markdown({ i18n: true }),
            },

            displayFields: { description: 'description', title: 'title' },
            route: '/posts/:slug',
        },
        settings: { fields: { slug: text(), enabled: boolean() }, publishing: false },
    },
})
