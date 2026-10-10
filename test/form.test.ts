import { describe, expect, it } from 'vitest'
import { nextTick, reactive, ref } from 'vue'

import {
    array,
    createSiteAdminDescriptor,
    defineSiteAdminConfig,
    file,
    image,
    images,
    text,
} from '../packages/site-admin/src'
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
    it.each(['getter', 'ref'] as const)(
        'reads a controlled %s slug at submission and honors initial overrides',
        async (kind) => {
            const external = ref<string | undefined>('override')
            const requests: Record<string, unknown>[] = []
            const options = {
                descriptor,
                entry: entry('existing', 1, { title: 'Initial' }),
                modelName: 'posts',
                fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
                    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
                    requests.push(body)
                    return Response.json({
                        ...entry('existing', requests.length + 1, body.data as Record<string, unknown>),
                        slug: body.slug ?? 'post',
                    })
                },
                ...(kind === 'ref' ? { slug: external } : {}),
            }
            if (kind === 'getter') Object.defineProperty(options, 'slug', { get: () => external.value })
            const controller = useSiteAdminForm<{ title: string }>(options)
            expect(controller.metadata.slug.value).toBe('override')
            external.value = 'changed-before-submit'
            await nextTick()
            await controller.form.handleSubmit()
            expect(requests[0]).toMatchObject({ expectedVersion: 1, slug: 'changed-before-submit' })
            external.value = undefined
            await nextTick()
            controller.form.setFieldValue('title', 'Updated')
            await controller.form.handleSubmit()
            expect(requests[1]).not.toHaveProperty('slug')
        },
    )

    it('lets the controller own slug when no controlled option is supplied', async () => {
        let submitted: unknown
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor,
            entry: entry('existing', 1, { title: 'Initial' }),
            modelName: 'posts',
            fetch: async (_input, init) => {
                submitted = JSON.parse(String(init?.body))
                return Response.json({ ...entry('existing', 2, { title: 'Initial' }), slug: 'controller' })
            },
        })
        controller.metadata.slug.value = 'controller'
        expect(controller.dirty.value).toBe(true)
        expect(controller.draft.serialize().slug).toBe('controller')
        await controller.form.handleSubmit()
        expect(submitted).toMatchObject({ slug: 'controller', expectedVersion: 1 })
        expect(controller.metadata.slug.value).toBe('controller')
    })

    it('keeps submitted values and updates identity when a mutation-only actor receives a receipt', async () => {
        const saved: unknown[] = []
        const controller = useSiteAdminForm<{ title: string }>({
            descriptor,
            defaultValues: { title: 'Initial' },
            modelName: 'posts',
            fetch: async () => Response.json({ id: 'receipt', model: 'posts', version: 3, sortOrder: null }),
            onSuccess: (result) => {
                saved.push(result)
            },
        })
        controller.form.setFieldValue('title', 'Submitted')
        await controller.form.handleSubmit()
        expect(controller.form.state.values).toEqual({ title: 'Submitted' })
        expect(controller.entryId.value).toBe('receipt')
        expect(controller.version.value).toBe(3)
        expect(controller.form.state.isPristine).toBe(true)
        expect(saved).toEqual([{ id: 'receipt', model: 'posts', version: 3, sortOrder: null }])
    })
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
                if (String(input).includes('/entries?'))
                    return Response.json({
                        items: [entry('author', 1, { title: 'Ada' })],
                        total: 1,
                        limit: 5,
                        offset: 0,
                    })
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

    it('accepts Core AssetInput values and rejects malformed image references in nested arrays', async () => {
        const assetDescriptor = createSiteAdminDescriptor(
            defineSiteAdminConfig({
                models: {
                    assets: {
                        fields: { cover: image(), attachment: file(), gallery: images(), nested: array(image()) },
                    },
                },
            }),
        ).models.assets!
        const saved: Record<string, unknown>[] = []
        const controller = useSiteAdminForm({
            descriptor: assetDescriptor,
            modelName: 'assets',
            fetch: async (_input, init) => {
                const data = JSON.parse(String(init?.body)).data as Record<string, unknown>
                saved.push(data)
                return Response.json(entry('asset-entry', saved.length, data))
            },
        })
        for (const value of ['asset-id', { id: 'asset-id', alt: 'Cover' }, null]) {
            controller.form.reset({
                cover: value,
                attachment: value,
                gallery: ['asset-id', { id: 'asset-id' }],
                nested: [value],
            })
            await controller.form.handleSubmit()
        }
        expect(saved).toHaveLength(3)
        for (const invalid of [{ id: '' }, {}, 1]) {
            controller.form.reset({ gallery: [invalid] })
            await controller.form.handleSubmit()
            expect(controller.form.state.isInvalid).toBe(true)
        }
        expect(saved).toHaveLength(3)
    })
})
