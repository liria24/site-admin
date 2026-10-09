import { useSiteAdmin } from '@liria24/site-admin/nuxt/server'
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(async (event) => {
    const admin = await useSiteAdmin(event)
    if ((await admin.listEntries('posts')).length === 0) {
        const en = await admin.createEntry('posts', {
            data: {
                description: 'English description',
                title: 'Hello',
                body: '---\nprivate: FULL_SSR_FRONTMATTER\n---\nNative summary\n\n<!-- more -->\n\nFULL_SSR_BODY_SENTINEL',
            },
            locale: 'en',
            translationGroup: 'hello',
        })
        const ja = await admin.createEntry('posts', {
            data: { description: '日本語の説明', title: 'こんにちは' },
            locale: 'ja',
            translationGroup: 'hello',
        })
        await admin.publishEntry(en.id, { expectedVersion: en.version })
        await admin.publishEntry(ja.id, { expectedVersion: ja.version })
        const link = await admin.createEntry('links', {
            data: { destination: 'https://example.com/destination', title: 'External' },
        })
        await admin.publishEntry(link.id, { expectedVersion: link.version })
    }
    return { seeded: true }
})
