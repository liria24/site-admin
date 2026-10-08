import { defineSiteAdminConfig, image, markdown, number, object, text } from '../packages/site-admin/src'
import type { PublicEntrySeo } from '../packages/site-admin/src/server/types'
import type { SiteAdminRouteRule } from '../packages/site-admin/src/seo'

const config = defineSiteAdminConfig({
    seo: { titleTemplate: '%s | Site', type: 'website' },
    routeRules: { '/posts/**': { seo: { titleTemplate: null, image: false }, sitemap: false, llms: true } },
    models: {
        posts: {
            fields: {
                title: text({ required: true }),
                cover: image(),
                body: markdown(),
                views: number({ required: true }),
                nested: object({ label: text({ required: true }) }),
            },
            seo: (entry) => {
                const title: string = entry.data.title
                const views: number = entry.data.views
                const publicImage: string | undefined = entry.data.cover?.url
                const markdownSource: string | null | undefined = entry.data.body
                const nestedLabel: string | undefined = entry.data.nested?.label
                // @ts-expect-error Resolver receives declared model field types.
                const wrongTitle: number = entry.data.title
                // @ts-expect-error Unknown model fields are not implicitly allowed.
                void entry.data.secret
                // @ts-expect-error Public image is hydrated, not an asset ID string.
                const storedImage: string | undefined = entry.data.cover
                void [views, publicImage, markdownSource, nestedLabel, wrongTitle, storedImage]
                return { title, image: false }
            },
        },
        private: { fields: { secret: text() }, public: false },
    },
})
const required: true = config.models.posts.fields.title.required
const privateModel: false = config.models.private.public
const globalType: 'website' = config.seo.type
const ruleTemplate: null = config.routeRules['/posts/**'].seo.titleTemplate
const ruleImage: false = config.routeRules['/posts/**'].seo.image
const ruleSitemap: false = config.routeRules['/posts/**'].sitemap
const dataSeo: PublicEntrySeo = {
    image: { component: 'PostOg', props: { count: 1, tags: ['one'], nested: { ok: true } } },
}
// @ts-expect-error DTO image props must remain JSON-only.
const invalidSeo: PublicEntrySeo = { image: { component: 'PostOg', props: { callback: () => 'secret' } } }
// @ts-expect-error Route sitemap switches are boolean.
const invalidRule: SiteAdminRouteRule = { sitemap: 'yes' }
void [required, privateModel, globalType, ruleTemplate, ruleImage, ruleSitemap, dataSeo, invalidSeo, invalidRule]
