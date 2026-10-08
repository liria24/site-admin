import { defineSiteAdminConfig, text } from '@liria24/site-admin'

export default defineSiteAdminConfig({
    database: { connector: 'd1', schema: './.data/schema/schema.ts', binding: 'DB' },
    models: { posts: { fields: { title: text({ required: true }) } } },
    tasks: { publishDue: '* * * * *', syncAssets: true },
})
