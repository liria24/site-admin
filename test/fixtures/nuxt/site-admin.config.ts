import { boolean, defineSiteAdminAuthorization, defineSiteAdminConfig, text, url } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    // Existing files.config.ts wins in full, including its sole storage selection.
    storage: { ignoredCommonStorage: { adapter: 'memory' } },
    assets: { maxUploadSize: 123 },
    ai: { models: { posts: { suggest: () => ({ data: { title: 'SITE_ADMIN_SERVER_ONLY_AI_SENTINEL' } }) } } },
    authorization: defineSiteAdminAuthorization({
        editor: { models: { posts: ['create', 'publish', 'readDraft', 'update'] } },
    }),
    database: {
        connector: 'sqlite',
        schema: './.data/schema/schema.ts',
        filename: './.data/content.sqlite3',
    },
    tasks: { publishDue: true, syncAssets: true },
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
