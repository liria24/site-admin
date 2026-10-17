import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import type { H3Event } from 'h3'
import {
    createPresentationContext,
    requestedPresentationLocale,
    resolvePublicPresentation,
} from '../packages/site-admin/src/runtime/presentation'
import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'

const require = createRequire(import.meta.resolve('@nuxtjs/i18n'))
const native = await import(pathToFileURL(require.resolve('@intlify/h3')).href)

it('binds concurrent native translations to each request and keeps UI locale separate from content locale', async () => {
    const middleware = native.defineI18nMiddleware({
        messages: { ja: { label: '記事' }, en: { label: 'Post' } },
        locale: async (event: H3Event) => {
            const locale = requestedPresentationLocale() ?? event.context.locale
            await new Promise((resolve) => setTimeout(resolve, locale === 'ja' ? 10 : 1))
            return locale
        },
    })
    const createEvent = (locale: string) => {
        const value = { context: { locale } } as unknown as H3Event
        middleware.onRequest(value)
        return value
    }
    const ja = createEvent('ja'),
        en = createEvent('en')
    const options = {
        locales: ['ja', 'en'],
        detect: (event: H3Event) => event.context.locale,
        translate: native.useTranslation,
    }
    const [first, second, content] = await Promise.all([
        createPresentationContext(ja, undefined, options),
        createPresentationContext(en, undefined, options),
        createPresentationContext(en, 'ja', options),
    ])
    expect([first.t('label'), second.t('label'), content.t('label')]).toEqual(['記事', 'Post', '記事'])
    expect(requestedPresentationLocale()).toBeUndefined()
    await expect(createPresentationContext(ja, 'fr', options)).rejects.toThrow('Unsupported presentation locale')
})

it('resolves model/field labels and public SEO without exporting functions or private configuration', () => {
    const config = defineSiteAdminConfig({
        seo: ({ t }) => ({ title: t('site') }),
        routeRules: { '/about': { seo: ({ t }) => ({ title: t('about') }) } },
        models: {
            posts: {
                meta: ({ t }) => ({ label: t('post'), plural: t('posts'), icon: 'book', fields: ['title'] }),
                fields: { title: text({ label: ({ t }) => t('title'), description: 'Plain description' }) },
            },
        },
    })
    const context = { locale: 'ja', t: (key: string) => 'ja:' + key }
    const descriptor = createSiteAdminDescriptor(config, context)
    expect(descriptor.models.posts?.meta).toEqual({
        label: 'ja:post',
        plural: 'ja:posts',
        icon: 'book',
        fields: ['title'],
    })
    expect(descriptor.models.posts?.fields.title?.label).toBe('ja:title')
    expect(resolvePublicPresentation(config, '/about', context)).toEqual({
        path: '/about',
        locale: 'ja',
        defaults: { title: 'ja:site' },
        route: { title: 'ja:about' },
    })
    expect(JSON.stringify(resolvePublicPresentation(config, '/about', context))).not.toContain('fields')
})
