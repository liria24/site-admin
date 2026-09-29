import {
    array,
    defineSiteAdminConfig,
    object,
    relation,
    select,
    text,
    type InferSiteAdminModels,
} from '../packages/site-admin/src'

const config = defineSiteAdminConfig({
    models: {
        authors: { fields: { name: text({ required: true }) } },
        posts: {
            fields: {
                sections: array(object({ author: relation('authors'), heading: text({ required: true }) })),
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
