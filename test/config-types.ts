import {
    defineSiteAdminConfig,
    text,
    type ResolvedSiteAdminConfig,
    type InferSiteAdminModels,
    type InferSiteAdminPublicModels,
} from '../packages/site-admin/src'

const common = defineSiteAdminConfig({
    models: { posts: { fields: { title: text({ required: true }) } } },
    storage: { content: { adapter: 'fs', config: { root: './files' } } },
    $production: { routes: [{ path: '/files', storage: 'content' }], assets: { maxUploadSize: 2 } },
    $env: { staging: { assets: { maxUploadSize: 3 } } },
})
const root: string = common.storage.content.config.root
const required: true = common.models.posts.fields.title.required
void root
void required

// @ts-expect-error Native Files fs provider options require root, not arbitrary copied options.
defineSiteAdminConfig({ models: {}, storage: { adapter: 'fs', config: { missing: true } } })
// @ts-expect-error Environment provider options are also checked by Files SDK's native types.
defineSiteAdminConfig({ models: {}, $production: { storage: { adapter: 'fs', config: { missing: true } } } })
// @ts-expect-error Unknown File storage option.
defineSiteAdminConfig({ models: {}, storage: { adapter: 'memory', madeUpOption: true } })

const environmentModels = defineSiteAdminConfig({
    models: { posts: { fields: { title: text({ required: true }) } } },
    $production: {
        models: {
            posts: { public: false, fields: { summary: text({ required: true }) } },
            pages: { fields: { title: text({ required: true }) } },
        },
    },
})
type Production = ResolvedSiteAdminConfig<typeof environmentModels, readonly ['production']>
const post: InferSiteAdminModels<Production>['posts'] = { title: 'Title', summary: 'Summary' }
const page: InferSiteAdminModels<Production>['pages'] = { title: 'Page' }
// @ts-expect-error Production adds the required summary field.
const missingSummary: InferSiteAdminModels<Production>['posts'] = { title: 'Title' }
// @ts-expect-error Production marks posts private.
type PrivatePublicPost = InferSiteAdminPublicModels<Production>['posts']
void post
void page
void missingSummary
const noPrivatePost: PrivatePublicPost = undefined
void noPrivatePost

// Application-owned adapters and SDK models replace as opaque values, including inferred types.
declare const originalDatabase: import('../packages/site-admin/src/adapter').SiteAdminDatabase & { oldMarker: true }
declare const productionDatabase: import('../packages/site-admin/src/adapter').SiteAdminDatabase & { replacement: true }
declare const originalModel: import('ai').LanguageModel & { oldMarker: true }
declare const productionModel: import('ai').LanguageModel & { replacement: true }
const opaqueEnvironment = defineSiteAdminConfig({
    models: {},
    database: originalDatabase,
    ai: { model: originalModel },
    $production: { database: productionDatabase, ai: { model: productionModel } },
})
declare const resolvedOpaque: ResolvedSiteAdminConfig<typeof opaqueEnvironment, readonly ['production']>
const replacedDatabase: true = resolvedOpaque.database.replacement
const replacedModel: true = resolvedOpaque.ai.model.replacement
// @ts-expect-error Replaced database methods/properties do not retain the old instance's keys.
void resolvedOpaque.database.oldMarker
// @ts-expect-error Replaced SDK model does not retain the old instance's keys.
void resolvedOpaque.ai.model.oldMarker
void replacedDatabase
void replacedModel

// @ts-expect-error An environment replaces the whole adapter, never a partial method bag.
defineSiteAdminConfig({ models: {}, $production: { database: { dialect: 'sqlite' } } })
// @ts-expect-error An environment replaces the whole SDK model, never a partial provider descriptor.
defineSiteAdminConfig({ models: {}, $production: { ai: { model: { specificationVersion: 'v4' } } } })

const seoImageEnvironment = defineSiteAdminConfig({
    models: {},
    seo: { image: { component: 'First', props: { old: true } } },
    $production: { seo: { image: { component: 'Second', props: { replacement: true } } } },
})
declare const resolvedImage: ResolvedSiteAdminConfig<typeof seoImageEnvironment, readonly ['production']>
// @ts-expect-error Replaced component descriptors do not retain old props.
void resolvedImage.seo.image.props.old
const productionImage: true = resolvedImage.seo.image.props.replacement
void productionImage
// @ts-expect-error An environment image override must be a complete component descriptor.
defineSiteAdminConfig({ models: {}, $production: { seo: { image: { props: { title: 'Incomplete' } } } } })

// Native 0.2 gateway callbacks use the public Nuxt RequestEvent, including inherited common storage.
const gateway = defineSiteAdminConfig({
    models: {},
    storage: { content: { adapter: 'memory' } },
    $production: {
        routes: [
            {
                path: '/files',
                storage: 'content',
                authorize: ({ event }) => {
                    const request: Request = event.req
                    // @ts-expect-error Native request events do not expose H3 Node adapters.
                    void event.node
                    void request
                    return undefined
                },
            },
        ],
    },
})
void gateway
