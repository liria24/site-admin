import { defineSiteAdminConfig, text } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    models: { posts: { fields: { slug: text(), title: text({ required: true }) } } },
    tasks: { publishDue: '* * * * *', syncAssets: true },
})
