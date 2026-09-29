import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import { createSiteAdminDescriptor, defineSiteAdminConfig, text } from '../packages/site-admin/src'
import { siteAdminFormDefaults, useSiteAdminForm } from '../packages/site-admin/src/form'
import type { EntryRecord } from '../packages/site-admin/src/server'

const descriptor = createSiteAdminDescriptor(
    defineSiteAdminConfig({
        models: {
            posts: { fields: { optional: text(), title: text({ minLength: 1, required: true }) } },
        },
    }),
).models.posts!

const entry = (id: string, version: number, data: Record<string, unknown>): EntryRecord => ({
    createdAt: '2026-01-01T00:00:00.000Z',
    currentRevisionId: `revision-${version}`,
    data,
    id,
    locale: '',
    model: 'posts',
    publishedAt: null,
    publishedRevisionId: null,
    revisionId: `revision-${version}`,
    scheduledAt: null,
    scheduledRevisionId: null,
    slug: 'post',
    sortOrder: null,
    translationGroup: id,
    updatedAt: '2026-01-01T00:00:00.000Z',
    version,
})

describe('form consumer', () => {
    it('clones defaults from Vue reactive descriptors without sharing arrays', () => {
        const reactiveDescriptor = reactive({
            ...descriptor,
            fields: {
                tags: { kind: 'array' as const, default: ['initial'], required: false, serverValidation: false },
            },
        })
        const values = siteAdminFormDefaults(reactiveDescriptor)
        expect(values).toEqual({ tags: ['initial'] })
        ;(values.tags as string[]).push('edited')
        expect(reactiveDescriptor.fields.tags.default).toEqual(['initial'])
    })

    it('omits optional defaults, changes create into update, and resets the saved baseline', async () => {
        expect(siteAdminFormDefaults(descriptor)).toEqual({ title: '' })
        const requests: Array<{ body: Record<string, unknown>; method: string; url: string }> = []
        const controller = useSiteAdminForm<{ optional?: string; title: string }>({
            descriptor,
            fetch: async (input, init) => {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>
                requests.push({ body, method: init?.method ?? 'GET', url: String(input) })
                const version = requests.length
                return Response.json(entry('created', version, { title: version === 1 ? 'Saved' : 'Saved again' }))
            },
            managementBase: '/manage',
            modelName: 'posts',
        })
        controller.form.setFieldValue('title', 'First')
        await controller.form.handleSubmit()
        expect(controller.entryId.value).toBe('created')
        expect(controller.version.value).toBe(1)
        expect(controller.form.state.values).toEqual({ title: 'Saved' })
        expect(controller.form.state.isPristine).toBe(true)

        controller.form.setFieldValue('title', 'Second')
        await controller.form.handleSubmit()
        expect(requests).toMatchObject([
            { method: 'POST', url: '/manage/entries/posts' },
            { body: { expectedVersion: 1 }, method: 'PATCH', url: '/manage/entries/created' },
        ])
        expect(controller.version.value).toBe(2)
        expect(controller.form.state.values).toEqual({ title: 'Saved again' })
    })

    it('keeps field/non-field server errors and conflict state through TanStack submission validation', async () => {
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor,
            fetch: async () =>
                Response.json(
                    {
                        error: {
                            code: 'SITE_ADMIN_CONFLICT',
                            issues: [{ message: 'Already used.', path: 'title' }],
                            message: 'The entry changed.',
                        },
                    },
                    { status: 409 },
                ),
            modelName: 'posts',
        })
        controller.form.setFieldValue('title', 'Valid client value')
        await controller.form.handleSubmit()
        expect(controller.conflict.value).toBe(true)
        expect(controller.serverError.value).toMatchObject({
            code: 'SITE_ADMIN_CONFLICT',
            issues: [{ message: 'Already used.', path: 'title' }],
        })
        expect(controller.form.state.isInvalid).toBe(true)
        expect(JSON.stringify(controller.form.state.errors)).toContain('The entry changed.')
    })

    it('searches relation candidates and exposes upload progress/failure state without deleting on clear', async () => {
        const calls: string[] = []
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor,
            fetch: async (input, _init) => {
                calls.push(String(input))
                if (String(input).includes('/entries?')) return Response.json([entry('author', 1, { title: 'Ada' })])
                if (String(input).endsWith('/assets')) {
                    expect(_init?.body).toBeInstanceOf(File)
                    expect(new Headers(_init?.headers).get('x-filename')).toBe('asset.txt')
                    expect(new Headers(_init?.headers).get('x-upload-size')).toBe('5')
                    return Response.json({ id: 'asset', state: 'ready' })
                }
                return Response.json(entry('post', 1, { title: 'Post' }))
            },
            modelName: 'posts',
        })
        expect(await controller.relation.search('authors', 'Ada', 'ja', 5)).toMatchObject([{ id: 'author' }])
        const asset = await controller.asset.upload(new File(['asset'], 'asset.txt'))
        expect(asset.id).toBe('asset')
        expect(controller.asset.progress.value).toBe(1)
        controller.asset.set('title', 'asset')
        controller.asset.clear('title')
        expect(controller.form.state.values.title).toBeNull()
        expect(calls).toEqual([
            '/api/site-admin/entries?model=authors&q=Ada&limit=5&locale=ja',
            '/api/site-admin/assets',
        ])
    })
})
