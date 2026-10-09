import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
    array,
    createSiteAdminDescriptor,
    defineSiteAdminConfig,
    file,
    image,
    images,
    markdown,
    object,
    text,
    url,
    type InferSiteAdminFormModels,
} from '../packages/site-admin/src'
import { createSiteAdminManagementClient, SiteAdminClientError } from '../packages/site-admin/src/client'
import {
    presentSiteAdminData,
    serializeSiteAdminData,
    useSiteAdminForm,
    type SiteAdminSessionDraft,
} from '../packages/site-admin/src/form'
import type { EntryRecord } from '../packages/site-admin/src/server/types'

const config = defineSiteAdminConfig({
    models: {
        posts: {
            displayFields: { description: 'summary', title: 'title' },
            fields: {
                title: text({ required: true }),
                copy: markdown(),
                summary: text(),
                image: image(),
                attachment: file(),
                gallery: images(),
                sections: array(object({ asset: image(), href: url() })),
            },
        },
    },
})
const descriptor = createSiteAdminDescriptor(config).models.posts!
type Data = InferSiteAdminFormModels<typeof config>['posts']
const entry = (id: string, version = 1, title = id): EntryRecord => ({
    id,
    model: 'posts',
    data: { title },
    slug: id,
    version,
    locale: '',
    sortOrder: null,
    translationGroup: id,
    currentRevisionId: 'revision',
    revisionId: 'revision',
    publishedAt: null,
    publishedRevisionId: null,
    scheduledAt: null,
    scheduledRevisionId: null,
    createdAt: '',
    updatedAt: '',
})
const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
}

describe('schema-aware management assets', () => {
    it('round-trips nested image/file/images/arrays, preserving metadata and ordinary URLs', () => {
        const raw = {
            title: 'Title',
            image: 'cover',
            attachment: { id: 'file', alt: 'File' },
            gallery: ['one', { id: 'two', caption: 'Two' }],
            sections: [{ asset: { id: 'nested', alt: 'Nested' }, href: 'https://example.com' }],
        }
        const presented = presentSiteAdminData<Data>(descriptor, raw, (id) => '/manage/' + encodeURIComponent(id))
        expect(presented.image?.url).toBe('/manage/cover')
        expect(presented.gallery?.[1]).toEqual({ id: 'two', caption: 'Two', url: '/manage/two' })
        expect(presented.sections?.[0]?.asset?.url).toBe('/manage/nested')
        expect(serializeSiteAdminData(descriptor, presented)).toEqual({
            ...raw,
            image: { id: 'cover' },
            gallery: [{ id: 'one' }, { id: 'two', caption: 'Two' }],
        })
        expect(raw.image).toBe('cover')
    })

    it('exposes upload URL and removes presentation URLs on submit and session serialization', async () => {
        const submitted: unknown[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            presentation: true,
            defaultValues: { title: 'Title' },
            fetch: async (input, init) => {
                if (String(input).endsWith('/assets')) return Response.json({ id: 'a/b', state: 'ready' })
                const data = JSON.parse(String(init?.body)).data as Record<string, unknown>
                submitted.push(data)
                return Response.json({ ...entry('saved'), data })
            },
        })
        const uploaded = await controller.upload(new File(['a'], 'a.txt'))
        expect(uploaded.url).toBe('/api/site-admin/assets/a%2Fb/content')
        controller.asset.set('image', uploaded)
        expect(controller.form.state.values.image?.url).toBe(uploaded.url)
        expect(controller.draft.serialize().data.image).toEqual({ id: 'a/b' })
        await controller.form.handleSubmit()
        expect(submitted).toEqual([{ title: 'Title', image: { id: 'a/b' } }])
        expect(controller.form.state.values.image?.url).toBe(uploaded.url)
        controller.form.setFieldValue('image', { ...uploaded, url: '/changed-display-url' })
        await nextTick()
        expect(controller.dirty.value).toBe(false)
    })
})

describe('session form controller', () => {
    it('preserves dirty drafts across IDs and remounts without rebasing their optimistic version', async () => {
        const drafts: Record<string, SiteAdminSessionDraft> = {}
        const id = ref<string | null>('a')
        let remoteVersion = 1
        const fetch = vi.fn(async (input: RequestInfo | URL) =>
            Response.json(entry(String(input).split('/').at(-1)!, remoteVersion)),
        )
        const scope = effectScope()
        const controller = scope.run(() =>
            useSiteAdminForm<Data>({ descriptor, modelName: 'posts', id, initialEntry: entry('a'), drafts, fetch }),
        )!
        controller.form.setFieldValue('title', 'Unsaved A')
        await nextTick()
        expect(controller.dirty.value).toBe(true)
        id.value = 'b'
        await flush()
        expect(controller.form.state.values.title).toBe('b')
        remoteVersion = 2
        id.value = 'a'
        await flush()
        expect(controller.form.state.values.title).toBe('Unsaved A')
        expect(controller.baseVersion.value).toBe(1)
        expect(controller.conflict.value).toBe(true)
        scope.stop()
        const remount = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            id: 'a',
            initialEntry: entry('a', 2),
            drafts,
            fetch,
        })
        expect(remount.form.state.values.title).toBe('Unsaved A')
        expect(remount.baseVersion.value).toBe(1)
        await remount.draft.discard()
        expect(remount.form.state.values.title).toBe('a')
        expect(remount.baseVersion.value).toBe(2)
        expect(remount.dirty.value).toBe(false)
    })

    it('aborts transport on ID changes and ignores a late response even if transport ignores abort', async () => {
        const id = ref('a')
        const pending = Promise.withResolvers<Response>()
        let signal: AbortSignal | undefined
        const scope = effectScope()
        const controller = scope.run(() =>
            useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                id,
                initialEntry: entry('a'),
                fetch: async (input, init) => {
                    if (String(input).endsWith('/slow')) {
                        signal = init?.signal ?? undefined
                        return pending.promise
                    }
                    return Response.json(entry('fast'))
                },
            }),
        )!
        id.value = 'slow'
        await nextTick()
        id.value = 'fast'
        await flush()
        expect(signal?.aborted).toBe(true)
        pending.resolve(Response.json(entry('slow')))
        await flush()
        expect(controller.entryId.value).toBe('fast')
        expect(controller.form.state.values.title).toBe('fast')
        scope.stop()
    })

    it('separates connection/auth/locale/new keys and drops old actor drafts after logout', async () => {
        const drafts: Record<string, SiteAdminSessionDraft> = {}
        const auth = ref('alice')
        const scope = effectScope()
        const alice = scope.run(() =>
            useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                authScope: auth,
                drafts,
                defaultValues: { title: 'New' },
            }),
        )!
        alice.form.setFieldValue('title', 'Alice draft')
        await nextTick()
        const other = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            authScope: 'alice',
            key: 'other',
            drafts,
            defaultValues: { title: 'Separate' },
        })
        expect(other.form.state.values.title).toBe('Separate')
        const connection = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            authScope: 'alice',
            origin: 'https://other.example',
            drafts,
            defaultValues: { title: 'Connection' },
        })
        expect(connection.form.state.values.title).toBe('Connection')
        auth.value = 'bob'
        await flush()
        expect(alice.form.state.values.title).toBe('New')
        expect(
            Object.keys(drafts).some(
                (key) => JSON.parse(key)[0] === '/api/site-admin' && JSON.parse(key)[1] === 'alice',
            ),
        ).toBe(false)
        scope.stop()
    })

    it('keeps errors and drafts on HTTP and network failures, and avoids a second create after observer/UI failure', async () => {
        let fail = true
        const requests: string[] = []
        const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
            onMutation: () => {
                throw new Error('Refresh failed')
            },
            fetch: async (_input, init) => {
                requests.push(init?.method ?? '')
                if (fail) throw new Error('Offline')
                return Response.json(entry('created', requests.length))
            },
        })
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            client,
            defaultValues: { title: 'New' },
            onSuccess: () => {
                throw new Error('Navigation failed')
            },
        })
        controller.form.setFieldValue('title', 'Draft')
        await controller.form.handleSubmit()
        expect(controller.entryId.value).toBeNull()
        expect(controller.serverError.value?.message).toBe('Offline')
        expect(controller.form.state.values.title).toBe('Draft')
        fail = false
        await controller.form.handleSubmit()
        expect(controller.entryId.value).toBe('created')
        expect(controller.callbackError.value).toBeInstanceOf(Error)
        controller.form.setFieldValue('title', 'Again')
        await controller.form.handleSubmit()
        expect(requests).toEqual(['POST', 'POST', 'PATCH'])
    })

    it('preserves edits made during save and clears a pending AI request after success', async () => {
        const save = Promise.withResolvers<Response>()
        const saveStarted = Promise.withResolvers<void>()
        const ai = Promise.withResolvers<Response>()
        let aiSignal: AbortSignal | undefined
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('created', 1, 'Submitted'),
            fetch: async (input, init) => {
                if (String(input).includes('/ai/')) {
                    aiSignal = init?.signal ?? undefined
                    return ai.promise
                }
                saveStarted.resolve()
                return save.promise
            },
        })
        const generating = controller.ai.run('proofread', { fields: ['title'] })
        const submitting = controller.form.handleSubmit()
        await saveStarted.promise
        controller.form.setFieldValue('title', 'Edited during save')
        save.resolve(Response.json(entry('created', 2, 'Submitted')))
        await submitting
        expect(controller.entryId.value).toBe('created')
        expect(controller.baseVersion.value).toBe(2)
        expect(controller.form.state.values.title).toBe('Edited during save')
        expect(controller.dirty.value).toBe(true)
        expect(controller.ai.busy.value).toBeNull()
        expect(aiSignal?.aborted).toBe(true)
        ai.resolve(Response.json({ data: { title: 'Late AI' }, issues: [], version: 1, baseRevisionId: 'revision' }))
        await generating
        expect(controller.ai.proposal.value).toBeNull()
    })

    it('preserves optional values removed during a pending save', async () => {
        const save = Promise.withResolvers<Response>()
        const started = Promise.withResolvers<void>()
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            defaultValues: { title: 'Title', summary: 'Before' },
            fetch: async () => {
                started.resolve()
                return save.promise
            },
        })
        const submitting = controller.form.handleSubmit()
        await started.promise
        controller.form.setFieldValue('summary', undefined)
        save.resolve(Response.json({ ...entry('created'), data: { title: 'Title', summary: 'Before' } }))
        await submitting
        expect(controller.form.state.values.summary).toBeUndefined()
        expect(controller.draft.serialize().data).not.toHaveProperty('summary')
        expect(controller.dirty.value).toBe(true)
    })

    it('does not run UI success callbacks for a saved identity left while the request was pending', async () => {
        const save = Promise.withResolvers<Response>()
        const started = Promise.withResolvers<void>()
        const id = ref('one')
        const onSuccess = vi.fn()
        const scope = effectScope()
        const controller = scope.run(() =>
            useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                id,
                initialEntry: entry('one'),
                onSuccess,
                fetch: async (input, init) => {
                    if (init?.method === 'PATCH') {
                        started.resolve()
                        return save.promise
                    }
                    return Response.json(entry(String(input).split('/').at(-1)!))
                },
            }),
        )!
        controller.form.setFieldValue('title', 'Saved one')
        const submitting = controller.form.handleSubmit()
        await started.promise
        id.value = 'two'
        await flush()
        save.resolve(Response.json(entry('one', 2, 'Saved one')))
        await submitting
        expect(controller.entryId.value).toBe('two')
        expect(controller.form.state.values.title).toBe('two')
        expect(onSuccess).not.toHaveBeenCalled()
        expect(controller.serverError.value).toBeNull()
        scope.stop()
    })

    it.each([401, 403, 404])(
        'preserves management read status %s instead of turning it into a new form',
        async (status) => {
            const id = ref('a')
            const scope = effectScope()
            const controller = scope.run(() =>
                useSiteAdminForm<Data>({
                    descriptor,
                    modelName: 'posts',
                    id,
                    initialEntry: entry('a'),
                    fetch: async () => Response.json({ error: { code: 'READ_FAILED', message: 'Denied' } }, { status }),
                }),
            )!
            id.value = 'denied'
            await flush()
            expect(controller.loadError.value).toBeInstanceOf(SiteAdminClientError)
            expect((controller.loadError.value as SiteAdminClientError).status).toBe(status)
            expect(controller.entryId.value).toBe('denied')
            scope.stop()
        },
    )
})

describe('controller AI proposals', () => {
    it.each([
        ['auto', 'auto'],
        ['manual', 'auto'],
        ['auto', 'manual'],
        ['manual', 'manual'],
    ] as const)(
        'saves %s/%s draft metadata without AI, without generation during save',
        async (slugMode, excerptMode) => {
            const calls: Array<{ path: string; body: Record<string, unknown> }> = []
            const controller = useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                defaultValues: { title: 'Title', copy: 'Original', summary: '' },
                fetch: async (input, init) => {
                    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
                    calls.push({ path: String(input), body })
                    if (String(input).includes('/ai/')) throw new Error('Draft saving must not invoke AI')
                    return Response.json({ ...entry('created'), slug: '', data: body.data })
                },
            })
            controller.metadata.setMode('slug', slugMode)
            controller.metadata.setMode('excerpt', excerptMode)
            await controller.form.handleSubmit()
            expect(calls).toHaveLength(1)
            expect(calls[0]?.body).toEqual({ data: { title: 'Title', copy: 'Original', summary: '' }, slug: '' })
            expect(controller.entryId.value).toBe('created')
            expect(controller.form.state.values.summary).toBe('')
            expect(controller.ai.busy.value).toBeNull()
        },
    )

    it('preserves application field validation without inferring or generating required metadata', async () => {
        const calls: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor: {
                ...descriptor,
                fields: {
                    ...descriptor.fields,
                    summary: { ...descriptor.fields.summary!, required: true, minLength: 1 },
                },
            },
            modelName: 'posts',
            defaultValues: { title: 'Title' },
            fetch: async (input, init) => {
                calls.push(String(input))
                return Response.json({ ...entry('created'), data: JSON.parse(String(init?.body)).data })
            },
        })
        await controller.form.handleSubmit()
        expect(calls).toEqual([])
        controller.form.setFieldValue('summary', 'Manual')
        await controller.form.handleSubmit()
        expect(calls).toEqual(['/api/site-admin/entries/posts'])
        expect(controller.form.state.values.summary).toBe('Manual')
    })

    it.each(['unavailable', 'empty', 'issues'] as const)(
        'keeps input during explicit %s AI proposals without any save',
        async (failure) => {
            const calls: string[] = []
            const controller = useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                entry: { ...entry('one'), data: { title: 'Title', copy: 'Original' } },
                fetch: async (input) => {
                    calls.push(String(input))
                    return failure === 'unavailable'
                        ? Response.json(
                              { error: { code: 'SITE_ADMIN_AI_UNAVAILABLE', message: 'Unavailable' } },
                              { status: 503 },
                          )
                        : Response.json({
                              data: { title: 'Title', summary: failure === 'empty' ? '' : 'Generated' },
                              slug: '',
                              issues: failure === 'issues' ? [{ path: 'summary', message: 'Invalid' }] : [],
                              version: 1,
                              baseRevisionId: 'revision',
                          })
                },
            })
            await controller.ai.run('metadata', {
                generate: {
                    slug: controller.metadata.modes.value.slug === 'auto',
                    excerpt: controller.metadata.modes.value.excerpt === 'auto',
                },
            })
            expect(calls).toHaveLength(1)
            expect(calls[0]).toContain('/ai/actions/metadata')
            expect(controller.entryId.value).toBe('one')
            expect(controller.form.state.values.copy).toBe('Original')
            expect(controller.form.state.values.summary).toBeUndefined()
            if (failure === 'unavailable') expect(controller.ai.error.value).toBeInstanceOf(SiteAdminClientError)
            if (failure === 'issues') expect(controller.ai.apply()).toBe(false)
        },
    )

    it.each(['input', 'identity'] as const)(
        'rejects explicit AI after %s changes while generation is pending',
        async (change) => {
            const generated = Promise.withResolvers<Response>()
            const started = Promise.withResolvers<void>()
            const id = ref<string | null>('one')
            const calls: string[] = []
            const scope = effectScope()
            const controller = scope.run(() =>
                useSiteAdminForm<Data>({
                    descriptor,
                    modelName: 'posts',
                    id,
                    initialEntry: entry('one', 1, 'Title'),
                    fetch: async (input) => {
                        calls.push(String(input))
                        if (String(input).includes('/ai/')) {
                            started.resolve()
                            return generated.promise
                        }
                        return Response.json(entry('two'))
                    },
                }),
            )!
            await controller.ready
            const proposing = controller.ai.run('metadata', {
                generate: {
                    slug: controller.metadata.modes.value.slug === 'auto',
                    excerpt: controller.metadata.modes.value.excerpt === 'auto',
                },
            })
            await started.promise
            if (change === 'input') controller.form.setFieldValue('title', 'Edited')
            else {
                id.value = 'two'
                await flush()
            }
            generated.resolve(
                Response.json({
                    data: { title: 'Title', summary: 'Late' },
                    slug: 'late',
                    issues: [],
                    version: 1,
                    baseRevisionId: 'revision',
                }),
            )
            await proposing
            expect(calls.some((path) => path.endsWith('/entries/posts'))).toBe(false)
            expect(controller.form.state.values.title).toBe(change === 'input' ? 'Edited' : 'two')
            expect(controller.form.state.values.summary).toBeUndefined()
            expect(controller.ai.proposal.value).toBeNull()
            expect(controller.ai.busy.value).toBeNull()
            scope.stop()
        },
    )

    it('keeps unapplied proofreading separate from a draft save and never generates metadata', async () => {
        let saved: Record<string, unknown> | undefined
        const paths: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: { ...entry('one'), data: { title: 'Title', copy: 'Original' } },
            fetch: async (input, init) => {
                paths.push(String(input))
                if (String(input).includes('/ai/actions/proofread'))
                    return Response.json({
                        data: { title: 'Title', copy: 'Proofread' },
                        issues: [],
                        version: 1,
                        baseRevisionId: 'revision',
                    })
                saved = JSON.parse(String(init?.body)).data
                return Response.json({ ...entry('created'), data: saved, slug: '' })
            },
        })
        await controller.ai.run('proofread', { fields: ['copy'] })
        expect(controller.ai.proposal.value?.data.copy).toBe('Proofread')
        await controller.form.handleSubmit()
        expect(paths).toHaveLength(2)
        expect(paths.some((path) => path.includes('/ai/actions/metadata'))).toBe(false)
        expect(saved?.copy).toBe('Original')
    })

    it('saves without an AI runtime even when legacy modes are automatic', async () => {
        let calls = 0
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            defaultValues: { title: 'Title' },
            fetch: async () => {
                calls++
                return Response.json({ ...entry('created'), slug: '' })
            },
        })
        expect(controller.metadata.modes.value).toEqual({ slug: 'manual', excerpt: 'manual' })
        controller.metadata.setMode('slug', 'auto')
        await controller.form.handleSubmit()
        expect(calls).toBe(1)
        expect(controller.serverError.value).toBeNull()
    })

    it('uses descriptor field names, metadata modes, and explicit apply without saving', async () => {
        const calls: Array<{ url: string; body: Record<string, unknown> }> = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: { ...entry('one'), data: { title: 'Title', copy: 'Before' } },
            fetch: async (input, init) => {
                const request = JSON.parse(String(init?.body)) as Record<string, unknown>
                const body = {
                    ...(request.props as Record<string, unknown>),
                }
                calls.push({ url: String(input), body })
                return Response.json({
                    data: { ...(body.data as object), copy: 'After', summary: 'Summary' },
                    issues: [],
                    version: 1,
                    baseRevisionId: 'revision',
                    slug: 'generated',
                })
            },
        })
        controller.metadata.setMode('slug', 'manual')
        controller.metadata.slug.value = 'manual-slug'
        controller.metadata.setMode('excerpt', 'auto')
        await controller.ai.run('metadata', {
            generate: {
                slug: controller.metadata.modes.value.slug === 'auto',
                excerpt: controller.metadata.modes.value.excerpt === 'auto',
            },
        })
        expect(calls[0]?.body.generate).toEqual({ slug: false, excerpt: true })
        expect(controller.form.state.values.copy).toBe('Before')
        controller.ai.discard()
        await controller.ai.run('proofread', { fields: ['copy'] })
        expect(calls[1]?.body.fields).toEqual(['copy'])
        expect(controller.ai.apply()).toBe(true)
        expect(controller.form.state.values.copy).toBe('After')
        expect(controller.dirty.value).toBe(true)
        expect(calls.every((call) => call.url.includes('/ai/'))).toBe(true)
    })

    it('rejects late replies after edits, identity changes, discard, or a newer request', async () => {
        const replies: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
        const id = ref('a')
        const scope = effectScope()
        const controller = scope.run(() =>
            useSiteAdminForm<Data>({
                descriptor,
                modelName: 'posts',
                id,
                initialEntry: entry('a'),
                fetch: async (input) => {
                    if (!String(input).includes('/ai/')) return Response.json(entry('b'))
                    const reply = Promise.withResolvers<Response>()
                    replies.push(reply)
                    return reply.promise
                },
            }),
        )!
        const request = controller.ai.run('proofread', { fields: ['title'] })
        controller.form.setFieldValue('title', 'Edited while generating')
        await nextTick()
        replies[0]!.resolve(
            Response.json({ data: { title: 'Old proposal' }, issues: [], version: 1, baseRevisionId: 'revision' }),
        )
        await request
        expect(controller.ai.stale.value).toBe(true)
        expect(controller.ai.apply()).toBe(false)
        const older = controller.ai.run('proofread', { fields: ['title'] })
        const newer = controller.ai.run('proofread', { fields: ['title'] })
        replies[2]!.resolve(
            Response.json({ data: { title: 'Newest' }, issues: [], version: 1, baseRevisionId: 'revision' }),
        )
        await newer
        replies[1]!.resolve(
            Response.json({ data: { title: 'Older' }, issues: [], version: 1, baseRevisionId: 'revision' }),
        )
        await older
        expect(controller.ai.proposal.value?.data.title).toBe('Newest')
        const switched = controller.ai.run('proofread', { fields: ['title'] })
        id.value = 'b'
        await flush()
        replies[3]!.resolve(
            Response.json({ data: { title: 'Wrong entry' }, issues: [], version: 1, baseRevisionId: 'revision' }),
        )
        await switched
        expect(controller.ai.proposal.value).toBeNull()
        expect(controller.form.state.values.title).toBe('b')
        expect(controller.ai.stale.value).toBe(false)
        scope.stop()
    })
})

describe('explicit application actions and publication controller', () => {
    it('does not overlap publication with an already pending draft save', async () => {
        const response = Promise.withResolvers<Response>(),
            started = Promise.withResolvers<void>()
        const paths: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('one'),
            fetch: async (input) => {
                paths.push(String(input))
                started.resolve()
                return response.promise
            },
        })
        const saving = controller.form.handleSubmit()
        await started.promise
        expect(await controller.publish()).toBeUndefined()
        expect(paths).toEqual(['/api/site-admin/entries/one'])
        response.resolve(Response.json(entry('one', 2)))
        await saving
        expect(controller.baseVersion.value).toBe(2)
    })
    it('holds typed proposals and lets the app select fields while preserving manual empty metadata', async () => {
        const calls: Array<{ path: string; body: Record<string, unknown>; signal?: AbortSignal }> = []
        const controller = useSiteAdminForm<Data, 'publication'>({
            descriptor,
            modelName: 'posts',
            entry: { ...entry('one'), data: { title: 'Title', copy: 'Manual body', summary: '' }, slug: '' },
            fetch: async (input, init) => {
                const body = JSON.parse(String(init?.body))
                calls.push({ path: String(input), body, ...(init?.signal ? { signal: init.signal } : {}) })
                return Response.json({
                    data: { title: 'Unrequested', copy: 'Corrected', summary: 'Unrequested' },
                    slug: 'generated',
                    version: 1,
                    baseRevisionId: 'revision',
                    issues: [],
                })
            },
        })
        controller.form.setFieldValue('title', 'Unsaved title')
        await controller.ai.run('publication', { selected: ['copy'] })
        expect(calls[0]?.body).toEqual({
            props: { selected: ['copy'] },
        })
        expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
        expect(controller.form.state.values.copy).toBe('Manual body')
        expect(controller.ai.apply({ fields: ['copy'], slug: false })).toBe(true)
        expect(controller.form.state.values).toMatchObject({ title: 'Unsaved title', copy: 'Corrected', summary: '' })
        expect(controller.metadata.slug.value).toBe('')
        expect(calls).toHaveLength(1)
        expect(controller.dirty.value).toBe(true)
    })

    it('uses one candidate request for repeated publish clicks and keeps edits made during publication', async () => {
        const response = Promise.withResolvers<Response>(),
            started = Promise.withResolvers<void>()
        const calls: Array<{ path: string; body: Record<string, unknown> }> = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            presentation: true,
            entry: { ...entry('one', 3, 'Before'), data: { title: 'Before', summary: 'Old', image: 'asset' } },
            fetch: async (input, init) => {
                calls.push({ path: String(input), body: JSON.parse(String(init?.body)) })
                started.resolve()
                return response.promise
            },
        })
        const first = controller.publish(),
            second = controller.publish()
        expect(first).toBe(second)
        await started.promise
        expect(controller.publishBusy.value).toBe(true)
        expect(calls).toEqual([
            {
                path: '/api/site-admin/entries/one/publish',
                body: {
                    expectedVersion: 3,
                    draft: { data: { title: 'Before', summary: 'Old', image: { id: 'asset' } }, slug: 'one' },
                },
            },
        ])
        controller.form.setFieldValue('title', 'Edited during publish')
        controller.form.setFieldValue('summary', undefined)
        response.resolve(
            Response.json({
                ...entry('one', 4, 'Before'),
                data: { title: 'Before', summary: 'Old', image: 'asset' },
                publishedRevisionId: 'published',
            }),
        )
        expect((await first)?.version).toBe(4)
        expect(controller.form.state.values.title).toBe('Edited during publish')
        expect(controller.form.state.values.summary).toBeUndefined()
        expect(controller.dirty.value).toBe(true)
        expect(controller.baseVersion.value).toBe(4)
        expect(controller.publishBusy.value).toBe(false)
    })

    it('keeps the draft on failed AI, blocks publication, and permits explicit retry/apply/publish', async () => {
        let attempt = 0
        const paths: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: { ...entry('one'), data: { title: 'Title', summary: '' } },
            fetch: async (input, init) => {
                paths.push(String(input))
                if (String(input).includes('/ai/'))
                    return ++attempt === 1
                        ? Response.json({ error: { code: 'SITE_ADMIN_AI_FAILED', message: 'Failed' } }, { status: 502 })
                        : Response.json({
                              data: { title: 'Title', summary: 'Proposed' },
                              slug: 'chosen',
                              version: 1,
                              baseRevisionId: 'revision',
                              issues: [],
                          })
                const draft = JSON.parse(String(init?.body)).draft
                return Response.json({
                    ...entry('one', 2),
                    data: draft.data,
                    slug: draft.slug,
                    publishedRevisionId: 'published',
                })
            },
        })
        await controller.ai.run('publication', {})
        expect(controller.form.state.values.summary).toBe('')
        expect(await controller.publish()).toBeUndefined()
        expect(paths).toHaveLength(1)
        await controller.ai.run('publication', {})
        expect(controller.ai.apply({ fields: ['summary'] })).toBe(true)
        const published = await controller.publish()
        expect(published?.version).toBe(2)
        expect(paths).toHaveLength(3)
        expect(controller.form.state.values.summary).toBe('Proposed')
    })

    it('rejects stale input and response versions, blocking publication until the app discards or regenerates', async () => {
        const pending = Promise.withResolvers<Response>(),
            started = Promise.withResolvers<void>()
        const paths: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('one'),
            fetch: async (input) => {
                paths.push(String(input))
                started.resolve()
                return pending.promise
            },
        })
        const generating = controller.ai.run('publication', {})
        await started.promise
        expect(await controller.publish()).toBeUndefined()
        controller.form.setFieldValue('title', 'Changed')
        pending.resolve(
            Response.json({ data: { title: 'Old' }, version: 1, baseRevisionId: 'revision', slug: 'old', issues: [] }),
        )
        await generating
        expect(controller.ai.stale.value).toBe(true)
        expect(controller.ai.apply()).toBe(false)
        expect(await controller.publish()).toBeUndefined()
        expect(paths).toHaveLength(1)
        controller.ai.discard()
        expect(controller.form.state.values.title).toBe('Changed')
        const wrongVersion = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('one'),
            fetch: async () =>
                Response.json({ data: { title: 'Wrong' }, version: 99, baseRevisionId: 'other', issues: [] }),
        })
        await wrongVersion.ai.run('publication', {})
        expect(wrongVersion.ai.stale.value).toBe(true)
        expect(wrongVersion.ai.apply()).toBe(false)
    })

    it('preserves submit failures/conflicts and allows a deliberate publish retry without creating entries', async () => {
        let failed = true
        const paths: string[] = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('one', 2),
            fetch: async (input) => {
                paths.push(String(input))
                return failed
                    ? Response.json({ error: { code: 'SITE_ADMIN_CONFLICT', message: 'Conflict' } }, { status: 409 })
                    : Response.json(entry('one', 3))
            },
        })
        controller.form.setFieldValue('title', 'Keep edits')
        expect(await controller.publish()).toBeUndefined()
        expect(controller.conflict.value).toBe(true)
        expect(controller.baseVersion.value).toBe(2)
        expect(controller.form.state.values.title).toBe('Keep edits')
        failed = false
        expect((await controller.publish())?.version).toBe(3)
        expect(paths).toEqual(['/api/site-admin/entries/one/publish', '/api/site-admin/entries/one/publish'])
    })

    it('schedules the current candidate and keeps the same typed mutation contract', async () => {
        const calls: Array<{ path: string; body: Record<string, unknown> }> = []
        const controller = useSiteAdminForm<Data>({
            descriptor,
            modelName: 'posts',
            entry: entry('one', 2),
            fetch: async (input, init) => {
                const body = JSON.parse(String(init?.body))
                calls.push({ path: String(input), body })
                return Response.json({ ...entry('one', 3), scheduledRevisionId: 'scheduled', scheduledAt: body.at })
            },
        })
        expect((await controller.schedule('2099-01-01T00:00:00Z'))?.version).toBe(3)
        expect(calls).toEqual([
            {
                path: '/api/site-admin/entries/one/schedule',
                body: {
                    at: '2099-01-01T00:00:00Z',
                    expectedVersion: 2,
                    draft: { data: { title: 'one' }, slug: 'one' },
                },
            },
        ])
        expect(controller.baseVersion.value).toBe(3)
    })
})
