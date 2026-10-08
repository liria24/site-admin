import siteAdmin from '@liria24/site-admin/nuxt'
// oxlint-disable-next-line unicorn/require-module-specifiers -- loads the module augmentation without a runtime import
import type {} from '@nuxtjs/i18n'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
    devtools: { enabled: false },
    i18n: {
        defaultLocale: 'en',
        locales: ['en', 'ja'],
        strategy: 'prefix_except_default',
    },
    llms: {
        domain: 'http://127.0.0.1',
        full: { description: 'All published content', title: 'Full site content' },
        title: 'Site content',
    },
    modules: [siteAdmin],
})
