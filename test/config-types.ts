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
