import {
    array,
    defineSiteAdminConfig,
    image,
    object,
    relation,
    select,
    text,
    type InferSiteAdminModels,
    type InferSiteAdminPublicModels,
} from '../packages/site-admin/src'

const config = defineSiteAdminConfig({
    models: {
        authors: { fields: { name: text({ required: true }) } },
        posts: {
            fields: {
                sections: array(object({ author: relation('authors'), heading: text({ required: true }) })),
                cover: image(),
                title: text({ required: true }),
            },
        },
    },
})

const post = {
    sections: [{ author: 'author_id', heading: 'Heading' }],
    title: 'Typed post',
} satisfies InferSiteAdminModels<typeof config>['posts']

void post

type PublicPost = InferSiteAdminPublicModels<typeof config>['posts']
const publicData = {
    cover: { id: 'asset', url: '/api/content/_assets/asset' },
    sections: [{ author: null, heading: 'Heading' }],
    title: 'Public post',
} satisfies PublicPost['data']
const publicAuthorName = (value: PublicPost): string | undefined => value.data.sections?.[0]?.author?.data.name
const nullablePublicItems: PublicPost['data']['sections'] = [null]
const requireFullRelatedData = (value: PublicPost): void => {
    const author = value.data.sections?.[0]?.author
    if (author) {
        // @ts-expect-error a relation cycle stub can omit the target's required fields
        const name: string = author.data.name
        void name
    }
}
// @ts-expect-error public image projections always include a URL
const invalidPublicCover: PublicPost['data']['cover'] = { id: 'asset' }
void publicData
void publicAuthorName
void nullablePublicItems
void requireFullRelatedData
void invalidPublicCover

const requiredConfig = defineSiteAdminConfig({
    models: {
        required: {
            fields: {
                items: array(text(), { required: true }),
                nested: object({ value: text({ required: true }) }, { required: true }),
                relation: relation('authors', { required: true }),
                status: select(['draft', 'published'] as const, { required: true }),
            },
        },
    },
})

const required = {
    items: [],
    nested: { value: 'yes' },
    relation: 'author_id',
    status: 'draft',
} satisfies InferSiteAdminModels<typeof requiredConfig>['required']

// @ts-expect-error every literal `required: true` field must be present
const missingRequired: InferSiteAdminModels<typeof requiredConfig>['required'] = { items: [], relation: 'id' }

void required
void missingRequired
