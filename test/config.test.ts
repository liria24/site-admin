import { describe, expect, it } from 'vitest'
import { defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { resolveSiteAdminConfig } from '../packages/site-admin/src/config-resolution'
import { resolveSiteAdminAssets } from '../packages/site-admin/src/assets-config'
import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'

describe('common Site Admin configuration', () => {
    const action = () => ({ data: { title: 'server-only suggestion' } })
    const config = defineSiteAdminConfig({
        storage: { content: { adapter: 'fs', config: { root: './.data/files' } } },
        assets: { maxUploadSize: 100 },
        ai: { models: { posts: { suggest: action } } },
        models: { posts: { fields: { title: text({ required: true, default: 'base' }) } } },
        $development: { assets: { maxUploadSize: 200 } },
        $production: {
            assets: { maxUploadSize: 300 },
            models: { posts: { fields: { title: { default: 'production' } } } },
        },
        $test: { assets: { maxUploadSize: 400 } },
        $prerender: { assets: { maxUploadSize: 500 } },
        $env: { staging: { assets: { maxUploadSize: 600 } } },
    })

    it.each([
        [['development'], 200],
        [['production'], 300],
        [['test'], 400],
        [['production', 'prerender'], 500],
        [['production', 'staging'], 600],
    ] as const)('resolves the entire configuration for %j', (environments, maxUploadSize) => {
        const resolved = resolveSiteAdminConfig(config, environments)
        expect(resolved.assets?.maxUploadSize).toBe(maxUploadSize)
        expect(resolved.ai?.models?.posts?.suggest).toBe(action)
        expect(Object.keys(resolved).some((key) => key.startsWith('$'))).toBe(false)
        expect(resolved.storage).toEqual(config.storage)
    })

    it('merges model defaults using the same resolver instead of a separate config path', () => {
        const resolved = resolveSiteAdminConfig(config, ['production'])
        expect(resolved.models.posts.fields.title.default).toBe('production')
        expect(resolved.models.posts.fields.title.required).toBe(true)
    })

    it('deep-merges direct and named domain overrides while replacing arrays and keeping functions', () => {
        const resolved = resolveSiteAdminConfig(
            defineSiteAdminConfig({
                models: {},
                assets: { maxUploadSize: 1 },
                $production: { assets: { maxUploadSize: 20 }, markdown: { plugins: [] } },
                $env: { production: { assets: { separateDrafts: true } } },
            }),
            ['production'],
        )
        expect(resolved.assets).toEqual({ maxUploadSize: 20, separateDrafts: true })
        expect(resolved.markdown?.plugins).toEqual([])
    })

    it('replaces complete SEO image descriptors across environment layers without mixing component props', () => {
        const base = { component: 'Development', props: { old: true }, options: { width: 800 } }
        const replacement = { component: 'Production', props: { fresh: true } }
        const resolved = resolveSiteAdminConfig(
            defineSiteAdminConfig({
                models: { posts: { fields: {}, seo: { image: base } } },
                seo: { image: base },
                routeRules: { '/posts/**': { seo: { image: base } } },
                $production: {
                    seo: { image: replacement },
                    models: { posts: { seo: { image: replacement } } },
                    routeRules: { '/posts/**': { seo: { image: replacement } } },
                },
            }),
            ['production'],
        )
        expect(resolved.seo.image).toEqual(replacement)
        expect(resolved.models.posts.seo.image).toEqual(replacement)
        expect(resolved.routeRules['/posts/**'].seo.image).toEqual(replacement)
    })

    it('infers a sole storage while requiring an explicit reference for multiple storages', () => {
        expect(resolveSiteAdminAssets(config.assets, config)?.storage).toBe('content')
        expect(resolveSiteAdminAssets({}, { storage: { adapter: 'fs', config: { root: '/tmp/test' } } })?.storage).toBe(
            'default',
        )
        const storage = { ...config.storage, other: config.storage.content }
        expect(() => resolveSiteAdminAssets({}, { storage })).toThrow('assets.storage is required')
        expect(() => resolveSiteAdminAssets({ storage: 'missing' }, { storage })).toThrow('unknown Files storage')
    })

    it('serializes only the safe descriptor, excluding storage options, AI and database code', () => {
        const serialized = JSON.stringify(createSiteAdminDescriptor(resolveSiteAdminConfig(config, ['development'])))
        expect(serialized).not.toContain('./.data/files')
        expect(serialized).not.toContain('server-only suggestion')
        expect(serialized).not.toContain('maxAttempts')
        expect(JSON.parse(serialized).assets.storage).toBe('content')
    })
})
