import { boolean, defineSiteAdminAuthorization, defineSiteAdminConfig, text, url } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    assets: { storage: 'content', maxUploadSize: 123 },
    authorization: defineSiteAdminAuthorization({
        editor: { models: { posts: ['create', 'publish', 'readDraft', 'update'] } },
    }),
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
