import {
    array,
    defineSiteAdminConfig,
    model,
    object,
    relation,
    text,
    type InferSiteAdminModels,
} from '../packages/site-admin/src'

const config = defineSiteAdminConfig({
    models: {
        authors: model({ fields: { name: text({ required: true }) } }),
        posts: model({
            fields: {
                sections: array(object({ author: relation('authors'), heading: text({ required: true }) })),
                title: text({ required: true }),
            },
        }),
    },
})

const post = {
    sections: [{ author: 'author_id', heading: 'Heading' }],
    title: 'Typed post',
} satisfies InferSiteAdminModels<typeof config>['posts']

void post
