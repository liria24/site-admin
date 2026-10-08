import { describe, expect, it } from 'vitest'

import { createSiteAdminManagementClient } from '../packages/site-admin/src/client'

describe('built-in AI management client', () => {
    it('serializes typed unsaved metadata and proofreading requests with same-origin credentials', async () => {
        const calls: Array<{ body: unknown; method: string; url: string }> = []
        const client = createSiteAdminManagementClient<
            Record<string, { body: string; summary: string; title: string }>
        >({
            basePath: '/manage/',
            fetch: async (input, init) => {
                expect(init?.credentials).toBe('same-origin')
                expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
                calls.push({
                    body: JSON.parse(String(init?.body)) as unknown,
                    method: init!.method!,
                    url: String(input),
                })
                return Response.json({ data: { title: 'Proposed title' }, issues: [], slug: 'proposed' })
            },
        })
        const input = { data: { title: 'Manual', summary: '' }, generate: { excerpt: false, slug: true }, slug: '' }
        expect(await client.generateMetadata('posts/example', input)).toEqual({
            data: { title: 'Proposed title' },
            issues: [],
            slug: 'proposed',
        })
        await client.proofreadDraft('posts/example', { data: { body: 'Draf' }, fields: ['body'] })
        expect(calls).toEqual([
            { body: input, method: 'POST', url: '/manage/models/posts%2Fexample/ai/metadata' },
            {
                body: { data: { body: 'Draf' }, fields: ['body'] },
                method: 'POST',
                url: '/manage/models/posts%2Fexample/ai/proofread',
            },
        ])
    })

    it('returns the whole proposed draft and validation issues without sending a save or publication request', async () => {
        const urls: string[] = []
        const proposal = {
            data: { body: 'Original body', title: 'Proofread title' },
            issues: [{ message: 'Required.', path: 'summary' }],
        }
        const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            fetch: async (input) => {
                urls.push(String(input))
                return Response.json(proposal)
            },
        })
        expect(await client.proofreadDraft('posts', { data: { body: 'Original body', title: 'Draf' } })).toEqual(
            proposal,
        )
        expect(urls).toEqual(['/api/site-admin/models/posts/ai/proofread'])
    })

    it('preserves AI error codes, status and issues through the existing client error transport', async () => {
        const client = createSiteAdminManagementClient({
            fetch: async () =>
                Response.json(
                    { error: { code: 'SITE_ADMIN_AI_OUTPUT_INVALID', message: 'AI returned an invalid response.' } },
                    { status: 502 },
                ),
        })
        await expect(client.generateMetadata('posts', { data: {}, generate: {} })).rejects.toMatchObject({
            code: 'SITE_ADMIN_AI_OUTPUT_INVALID',
            message: 'AI returned an invalid response.',
            status: 502,
        })
    })
})
