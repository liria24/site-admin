import { describe, expect, it } from 'vitest'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import type { MarkdownDocument } from 'comark'

import {
    array,
    defineSiteAdminConfig,
    markdown,
    object,
    relation,
    text,
    type InferSiteAdminPublicModels,
} from '../packages/site-admin/src'
import { createSiteAdminClient } from '../packages/site-admin/src/client'
import { handlePublicRequest } from '../packages/site-admin/src/server'
import { createMigratedTestAdmin } from './migrate'

const config = defineSiteAdminConfig({
    models: {
        authors: { fields: { name: text({ required: true }), bio: markdown({ required: true }) } },
        posts: {
            fields: {
                title: text({ required: true }),
                body: markdown({ required: true }),
                sections: array(object({ body: markdown({ required: true }) }), { required: true }),
                author: relation('authors', { required: true }),
            },
        },
    },
})

describe('public client Markdown contract', () => {
    it('keeps every summary after sequential detail routes and full HTTP reads', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        const configured = defineSiteAdminConfig({
            models: {
                posts: {
                    route: '/posts/:slug',
                    displayFields: { description: 'body' },
                    fields: { title: text(), body: markdown() },
                },
            },
        })
        try {
            const admin = await createMigratedTestAdmin({ config: configured, database })
            const client = createSiteAdminClient<
                InferSiteAdminPublicModels<typeof configured>,
                InferSiteAdminPublicModels<typeof configured, 'summary'>
            >({
                origin: 'http://localhost',
                fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
            })
            for (const slug of ['one', 'two']) {
                const entry = await admin.createEntry('posts', {
                    slug,
                    data: {
                        title: slug,
                        body: `${slug} introduction\n\n<!-- more -->\n\nFULL_SENTINEL_${slug}`,
                    },
                })
                await admin.publishEntry(entry.id, { expectedVersion: entry.version })
                expect(await admin.resolvePath(`/posts/${slug}`)).toMatchObject({ entry: { slug } })
                expect(JSON.stringify(await client.get('posts', slug))).toContain(`FULL_SENTINEL_${slug}`)
            }
            const response = await handlePublicRequest(
                admin,
                new Request('http://localhost/api/content/posts?markdown=summary'),
            )
            const payload = await response.text()
            expect(response.status).toBe(200)
            expect(payload).toContain('one introduction')
            expect(payload).toContain('two introduction')
            expect(payload).not.toContain('FULL_SENTINEL_')
            const summary = await client.list('posts', { markdown: 'summary' })
            expect(summary.map(({ slug }) => slug).sort()).toEqual(['one', 'two'])
            expect(summary.map(({ seo }) => seo?.description ?? '').sort()).toEqual([
                'one introduction',
                'two introduction',
            ])
            expect(JSON.stringify(await client.list('posts'))).toContain('FULL_SENTINEL_one')
            expect(JSON.stringify(await client.list('posts'))).toContain('FULL_SENTINEL_two')
            expect((await client.list('posts', { markdown: 'summary' })).map(({ slug }) => slug).sort()).toEqual([
                'one',
                'two',
            ])
        } finally {
            await database.dispose()
        }
    })
    it('returns real Comark documents for this model and string Markdown inside related projections', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        try {
            const admin = await createMigratedTestAdmin({ config, database })
            const author = await admin.createEntry('authors', { data: { bio: 'Author **bio**', name: 'Author' } })
            await admin.publishEntry(author.id, { expectedVersion: author.version })
            const post = await admin.createEntry('posts', {
                data: {
                    author: author.id,
                    body: '---\nlabel: Frontmatter\n---\nIntro\n\n<!-- more -->\n\n**Body**',
                    sections: [{ body: '# Section' }],
                    title: 'Post',
                },
            })
            await admin.publishEntry(post.id, { expectedVersion: post.version })
            const client = createSiteAdminClient<InferSiteAdminPublicModels<typeof config>>({
                origin: 'http://localhost',
                fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
            })
            const [listed] = await client.list('posts')
            const fetched = await client.get('posts', post.id)
            expect(fetched).toEqual(listed)
            const document: MarkdownDocument<Record<string, unknown>, Record<string, unknown>> = fetched!.data.body
            expect(document.frontmatter).toEqual({ label: 'Frontmatter' })
            expect(document.nodes).toContainEqual(['p', {}, ['strong', {}, 'Body']])
            expect(document.meta.summary).toEqual([['p', {}, 'Intro']])
            const summary: import('comark').Node[] | undefined = fetched!.data.body.meta.summary
            expect(summary).toEqual([['p', {}, 'Intro']])
            expect(fetched!.data.sections[0]!.body.nodes).toEqual([['h1', { id: 'section' }, 'Section']])
            const relatedMarkdown: string | undefined = fetched!.data.author?.data.bio
            expect(relatedMarkdown).toBe('Author **bio**')
            const standaloneAuthor = await client.get('authors', author.id)
            expect(standaloneAuthor!.data.bio.nodes).toEqual([['p', {}, 'Author ', ['strong', {}, 'bio']]])
            expect(standaloneAuthor!.data.bio.meta.summary).toEqual([['p', {}, 'Author ', ['strong', {}, 'bio']]])
            // The direct server projection retains its separate string contract.
            expect((await admin.getPublicEntry('posts', post.id))!.data.body).toContain('**Body**')
        } finally {
            await database.dispose()
        }
    })

    it('projects nested and related list summaries without body/frontmatter/plugin copies and preserves the full cache', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        const configured = defineSiteAdminConfig({
            ...config,
            markdown: {
                plugins: [
                    {
                        name: 'source-copy',
                        post(state) {
                            state.tree.meta.rawSource = state.markdown
                        },
                    },
                ],
            },
            models: { ...config.models, posts: { ...config.models.posts, displayFields: { description: 'body' } } },
        })
        try {
            const admin = await createMigratedTestAdmin({ config: configured, database })
            const source = (label: string) =>
                `---\nprivate: FULL_FRONTMATTER_${label}\n---\n${label} summary\n\n<!-- more -->\n\nFULL_BODY_${label}`
            const author = await admin.createEntry('authors', { data: { name: 'Author', bio: source('AUTHOR') } })
            await admin.publishEntry(author.id, { expectedVersion: author.version })
            const post = await admin.createEntry('posts', {
                data: {
                    title: 'Post',
                    body: source('POST'),
                    sections: [{ body: source('NESTED') }],
                    author: author.id,
                },
            })
            await admin.publishEntry(post.id, { expectedVersion: post.version })
            const client = createSiteAdminClient<
                InferSiteAdminPublicModels<typeof configured>,
                InferSiteAdminPublicModels<typeof configured, 'summary'>
            >({
                origin: 'http://localhost',
                fetch: (input, init) => handlePublicRequest(admin, new Request(input, init)),
            })
            const content = await admin.content('posts')
            const cached = await content.list()
            const before = JSON.stringify(cached)
            const response = await handlePublicRequest(
                admin,
                new Request('http://localhost/api/content/posts?markdown=summary'),
            )
            const payload = await response.text()
            expect(response.ok).toBe(true)
            expect(payload).not.toContain('FULL_BODY_')
            expect(payload).not.toContain('FULL_FRONTMATTER_')
            expect(payload).not.toContain('rawSource')
            expect(JSON.stringify(await content.list())).toBe(before)
            const [item] = await client.list('posts', { markdown: 'summary' })
            expect(item!.data.body).toEqual({
                nodes: [['p', {}, 'POST summary']],
                frontmatter: {},
                meta: { summary: [['p', {}, 'POST summary']] },
            })
            expect(item!.data.sections[0]!.body.nodes).toEqual([['p', {}, 'NESTED summary']])
            const relatedNodes: import('comark').Node[] | undefined = item!.data.author?.data.bio?.nodes
            expect(relatedNodes).toEqual([['p', {}, 'AUTHOR summary']])
            expect(item!.seo?.description).toBe('POST summary')
            item!.data.body.nodes.push(['p', {}, 'local mutation'])
            expect(JSON.stringify(await client.get('posts', post.id))).toContain('FULL_BODY_POST')
            expect(JSON.stringify(await client.list('posts'))).toContain('FULL_BODY_POST')
            expect(JSON.stringify(await content.list())).toBe(before)
            expect(
                (await handlePublicRequest(admin, new Request('http://localhost/api/content/posts?markdown=invalid')))
                    .status,
            ).toBe(400)
        } finally {
            await database.dispose()
        }
    })

    it.each([false, true])(
        'returns empty rendering nodes when summary is disabled, including related Markdown (custom plugin: %s)',
        async (custom) => {
            const database = createDatabase(nodeSqlite({ name: ':memory:' }))
            try {
                const admin = await createMigratedTestAdmin({
                    config: {
                        ...config,
                        markdown: {
                            summary: { enabled: false },
                            ...(custom
                                ? {
                                      plugins: [
                                          {
                                              name: 'custom-summary',
                                              post(state) {
                                                  state.tree.meta.summary = [['p', {}, 'FULL_DISABLED_PLUGIN']]
                                                  state.tree.meta.custom = 'kept'
                                              },
                                          },
                                      ],
                                  }
                                : {}),
                        },
                    },
                    database,
                })
                const author = await admin.createEntry('authors', {
                    data: { name: 'Author', bio: 'FULL_DISABLED_AUTHOR' },
                })
                await admin.publishEntry(author.id, { expectedVersion: author.version })
                const post = await admin.createEntry('posts', {
                    data: { title: 'Post', body: 'FULL_DISABLED_POST', sections: [], author: author.id },
                })
                await admin.publishEntry(post.id, { expectedVersion: post.version })
                const response = await handlePublicRequest(
                    admin,
                    new Request('http://localhost/api/content/posts?markdown=summary'),
                )
                const payload = await response.text()
                expect(payload).not.toContain('FULL_DISABLED_')
                const [item] = JSON.parse(payload) as Array<{
                    data: { body: { nodes: unknown[] }; author: { data: { bio: { nodes: unknown[] } } } }
                }>
                expect(item!.data.body.nodes).toEqual([])
                expect(item!.data.author.data.bio.nodes).toEqual([])
                if (custom) {
                    const full = await (await admin.content('posts')).list()
                    expect(full[0]?.data.body).toMatchObject({
                        meta: { custom: 'kept', summary: [['p', {}, 'FULL_DISABLED_PLUGIN']] },
                    })
                }
            } finally {
                await database.dispose()
            }
        },
    )
})
