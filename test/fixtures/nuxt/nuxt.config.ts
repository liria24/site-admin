import siteAdmin from '@liria24/site-admin/nuxt'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
    devtools: { enabled: false },
    modules: [siteAdmin],
    siteAdmin: {
        auth: { enabled: false },
        database: { connector: 'node-sqlite', path: '.data/site-admin.sqlite3' },
        llms: { enabled: true, full: true },
        ogImage: false,
        robots: false,
        schemaOrg: false,
        seo: false,
        sitemap: false,
    },
})
