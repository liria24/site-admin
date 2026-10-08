import { describe, expect, it, vi } from 'vitest'
import { stripTypeScriptTypes } from 'node:module'

import { siteAdminNuxtSeoTemplate } from '../packages/site-admin/src/nuxt/client-templates'

interface SeoOptions {
    title?: string
    titleTemplate?: string
    description?: string
    image?: { component: string; props?: Record<string, unknown>; options?: unknown }
    type?: 'website' | 'article'
    twitterCard?: 'summary' | 'summary_large_image'
}

const initialize = (ogImage: boolean) => {
    const useHead = vi.fn()
    const useSeoMeta = vi.fn()
    const defineOgImage = vi.fn()
    const source = siteAdminNuxtSeoTemplate({ ogImage }).replace(/^import .*\n/gmu, '')
    const compiled = stripTypeScriptTypes(source).replace(/^export /gmu, '')
    const create = new Function('useHead', 'useSeoMeta', 'defineOgImage', `${compiled}\nreturn defineSeo`) as (
        ...dependencies: unknown[]
    ) => (options: SeoOptions) => void
    return { defineSeo: create(useHead, useSeoMeta, defineOgImage), defineOgImage, useHead, useSeoMeta }
}

describe('generated Nuxt defineSeo', () => {
    it('applies the existing title, social metadata and defaults without website-specific head tags', () => {
        const { defineSeo, defineOgImage, useHead, useSeoMeta } = initialize(true)
        expect(defineSeo({ title: 'Page', titleTemplate: '%s | Example', description: 'Description' })).toBeUndefined()
        expect(useSeoMeta).toHaveBeenCalledWith({
            title: 'Page',
            titleTemplate: '%s | Example',
            ogTitle: 'Page',
            description: 'Description',
            ogDescription: 'Description',
            twitterTitle: 'Page',
            twitterDescription: 'Description',
            twitterCard: 'summary_large_image',
        })
        expect(useHead).toHaveBeenCalledWith({ meta: [{ property: 'og:type', content: 'website' }] })
        expect(defineOgImage).not.toHaveBeenCalled()
        expect(JSON.stringify(useHead.mock.calls)).not.toContain('favicon')
    })

    it('forwards OG component props/options unchanged and honors explicit article/card values', () => {
        const { defineSeo, defineOgImage, useHead, useSeoMeta } = initialize(true)
        const props = { title: 'Page' }
        const options = [{ key: 'og' }, { key: 'square', width: 800, height: 800 }]
        defineSeo({ type: 'article', twitterCard: 'summary', image: { component: 'Home.takumi', props, options } })
        expect(defineOgImage).toHaveBeenCalledExactlyOnceWith('Home.takumi', props, options)
        expect(useHead).toHaveBeenCalledWith({ meta: [{ property: 'og:type', content: 'article' }] })
        expect(useSeoMeta).toHaveBeenCalledWith(expect.objectContaining({ twitterCard: 'summary' }))
    })

    it('does not refer to the optional OG helper or types when OG image support is disabled', () => {
        const source = siteAdminNuxtSeoTemplate({ ogImage: false })
        expect(source).not.toContain('defineOgImage')
        expect(source).not.toContain('OgImageInput')
        expect(source).toContain('image?: never')
        const { defineSeo, defineOgImage, useHead } = initialize(false)
        defineSeo({ title: 'Page' })
        expect(defineOgImage).not.toHaveBeenCalled()
        expect(useHead).toHaveBeenCalledOnce()
    })
})
