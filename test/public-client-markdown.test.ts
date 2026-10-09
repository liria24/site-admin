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
})
