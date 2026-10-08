import { defineNuxtConfig } from 'nuxt/config'
import siteAdmin from '@liria24/site-admin/nuxt'
import type { NitroConfig } from 'nitropack/types'

const nitro = { preset: 'cloudflare-module', static: false, cloudflare: { nodeCompat: true } } satisfies NitroConfig

export default defineNuxtConfig({
    devtools: { enabled: false },
    modules: [siteAdmin],
    siteAdmin: {
        auth: false,
        i18n: false,
        llms: false,
        ogImage: false,
        robots: false,
        routing: { enabled: false },
        schemaOrg: false,
        seo: false,
        sitemap: false,
    },
    nitro,
})
