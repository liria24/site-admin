import { describe, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive } from 'vue'
import { useEntryForm, siteAdminFormDefaults } from '../packages/site-admin/src/form'
import { siteAdminModelContext } from '../packages/site-admin/src/model'
import { formDescriptor, modelEntry, modelFixture } from './model-fixture'

describe('native resource form', () => {
    it('retains dirty input and reports conflicts after AsyncData clears its previous error', () => {
        const { resource } = modelFixture(async () => Response.json(null))
        const editor = useEntryForm(resource)
        editor.form.setFieldValue('title', 'Local input')
        resource.status.value = 'pending'
        resource.data.value = modelEntry('one', 2, { title: 'Remote input' })
        resource.error.value = undefined
        resource.status.value = 'success'
        expect(resource.error.value).toMatchObject({ data: { code: 'SITE_ADMIN_CONFLICT' } })
        expect(editor.form.state.values.title).toBe('Local input')
        expect(editor.draft.snapshot().version).toBe(1)
    })
    it('clones defaults from reactive descriptors', () => {
        const descriptor = reactive({
            ...formDescriptor,
            fields: { gallery: { kind: 'images' as const, required: true, serverValidation: false, default: [] } },
        })
        const a = siteAdminFormDefaults(descriptor)
        const b = siteAdminFormDefaults(descriptor)
        expect(a.gallery).not.toBe(b.gallery)
    })
    it('returns native fields and saves slug and data through one validation path', async () => {
        const requests: unknown[] = []
        const fixture = modelFixture(async (_input, init) => {
            const body = JSON.parse(String(init?.body))
            requests.push(body)
            return Response.json({ ...modelEntry('one', 2, body.data), slug: body.slug })
        })
        const formState = useEntryForm(fixture.resource)
        expect(formState.form.Field).toBeDefined()
        expect(formState.form.Subscribe).toBeDefined()
        formState.form.setFieldValue('slug', 'new-slug')
        formState.form.setFieldValue('title', 'Updated')
        await formState.form.handleSubmit()
        expect(requests).toEqual([{ expectedVersion: 1, data: { slug: 'new-slug', title: 'Updated' } }])
        expect(formState.draft.isDirty.value).toBe(false)
        expect(formState.draft.snapshot()).toMatchObject({ entryId: 'one', version: 2 })
        expect(formState.fields.value.find((field) => field.key === 'title')?.name).toBe('title')
        expect(formState.form).not.toHaveProperty('ai')
        expect(formState.form).not.toHaveProperty('serverError')
    })
    it('validates nested fields before sending and maps server issues to native field paths', async () => {
        const request = vi.fn(async () =>
            Response.json(
                {
                    error: {
                        code: 'SITE_ADMIN_VALIDATION_FAILED',
                        message: 'Rejected',
                        issues: [{ path: 'title', message: 'Taken' }],
                    },
                },
                { status: 422 },
            ),
        )
        const { resource } = modelFixture(request)
        const formState = useEntryForm(resource)
        formState.form.setFieldValue('title', '')
        await formState.form.handleSubmit()
        expect(request).not.toHaveBeenCalled()
        formState.form.setFieldValue('title', 'Retry')
        await formState.form.handleSubmit()
        expect(resource.error.value?.data).toMatchObject({
            code: 'SITE_ADMIN_VALIDATION_FAILED',
            issues: [{ path: 'title', message: 'Taken' }],
        })
        expect(formState.form.state.values.title).toBe('Retry')
        expect(formState.form.state.errors.length).toBeGreaterThan(0)
        expect(resource.status.value).toBe('error')
    })
    it('creates once, then uses the receipt version after a UI callback failure', async () => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> = []
        const { resource } = modelFixture(async (input, init) => {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
            return Response.json({ id: 'created', model: 'posts', version: requests.length, sortOrder: null })
        }, null)
        const formState = useEntryForm(resource, {
            defaultValues: { title: 'New' },
            onSuccess: () => {
                throw new Error('Navigation failed')
            },
        })
        await formState.form.handleSubmit()
        expect(resource.error.value?.data?.committed).toBe(true)
        formState.form.setFieldValue('title', 'Second')
        await formState.form.handleSubmit()
        expect(requests.map((item) => item.url)).toEqual([
            'http://site.test/api/site-admin/entries/posts',
            'http://site.test/api/site-admin/entries/created',
        ])
        expect(requests[1]?.body.expectedVersion).toBe(1)
    })
    it('keeps edits and removed optional fields made during an in-flight save', async () => {
        const reply = Promise.withResolvers<Response>()
        const { resource } = modelFixture(
            async () => reply.promise,
            modelEntry('one', 1, { title: 'Initial', optional: 'Old' }),
        )
        const formState = useEntryForm(resource)
        formState.form.setFieldValue('title', 'Submitted')
        const pending = formState.form.handleSubmit()
        await vi.waitFor(() => expect(resource.status.value).toBe('pending'))
        formState.form.setFieldValue('title', 'Later')
        formState.form.setFieldValue('optional', undefined)
        reply.resolve(Response.json(modelEntry('one', 2, { title: 'Submitted', optional: 'Old' })))
        await pending
        expect(formState.form.state.values).toEqual({ title: 'Later', optional: undefined })
        expect(formState.draft.isDirty.value).toBe(true)
    })
    it('retains drafts across identities and rejects stale saved versions', async () => {
        const fixture = modelFixture(async () => Response.json(modelEntry()))
        const scope = effectScope()
        const formState = scope.run(() => useEntryForm(fixture.resource))!
        formState.form.setFieldValue('title', 'Unsaved')
        const current = computed(() => formState.draft.snapshot())
        const snapshot = current.value
        const stale = computed(() => formState.draft.isStale(snapshot))
        expect(stale.value).toBe(false)
        formState.form.setFieldValue('slug', 'edited')
        expect(current.value.draft.slug).toBe('edited')
        expect(stale.value).toBe(true)
        fixture.identity.value = 'alice:posts:two'
        fixture.state.data.value = modelEntry('two')
        await nextTick()
        expect(formState.form.state.values.title).toBe('Initial')
        fixture.identity.value = 'alice:posts:one'
        fixture.state.data.value = modelEntry('one', 2)
        await nextTick()
        expect(formState.form.state.values.title).toBe('Unsaved')
        expect(fixture.resource.error.value?.data?.code).toBe('SITE_ADMIN_CONFLICT')
        scope.stop()
    })
    it('keeps the original draft version when remounting after a remote edit', async () => {
        let writes = 0
        const request: typeof fetch = async () => {
            writes++
            return Response.json(modelEntry())
        }
        const first = modelFixture(request)
        const scope = effectScope()
        const editing = scope.run(() => useEntryForm(first.resource))!
        editing.form.setFieldValue('title', 'Unsaved')
        scope.stop()
        const next = modelFixture(request, modelEntry('one', 2, { title: 'Remote edit' }), first.drafts)
        const restoredState = useEntryForm(next.resource)
        expect(restoredState.form.state.values.title).toBe('Unsaved')
        expect(restoredState.draft.snapshot().version).toBe(1)
        expect(next.resource.error.value?.data?.code).toBe('SITE_ADMIN_CONFLICT')
        await restoredState.form.handleSubmit()
        expect(writes).toBe(0)
    })
    it('restores local input before the descriptor and entry finish loading', () => {
        const first = modelFixture(async () => Response.json(null))
        const scope = effectScope()
        const editing = scope.run(() => useEntryForm(first.resource))!
        editing.form.setFieldValue('title', 'Unsaved')
        editing.form.setFieldValue('slug', 'manual-url')
        editing.form.setFieldValue('publication', { slug: 'manual' })
        editing.form.setFieldValue('image', { id: 'draft-image' })
        scope.stop()
        first.drafts[first.identity.value]!.value.retired = 'Old field'
        const next = modelFixture(async () => Response.json(null), null, first.drafts)
        next.identity.value = first.identity.value
        next.id.value = first.id.value
        const context = next.resource[siteAdminModelContext]
        context.descriptor.value = undefined
        next.resource.status.value = 'pending'
        const restored = useEntryForm(next.resource)
        expect(restored.form.state.values).toMatchObject({
            title: 'Unsaved',
            slug: 'manual-url',
            publication: { slug: 'manual' },
        })
        context.descriptor.value = formDescriptor
        next.resource.data.value = modelEntry()
        next.resource.status.value = 'success'
        expect(restored.form.state.values).toMatchObject({
            title: 'Unsaved',
            slug: 'manual-url',
            publication: { slug: 'manual' },
        })
        expect(restored.form.state.values.image).toEqual({
            id: 'draft-image',
            url: next.client.assetUrl('draft-image'),
        })
        expect(restored.form.state.values).not.toHaveProperty('retired')
        expect(restored.draft.isDirty.value).toBe(true)
        expect(restored.draft.snapshot().version).toBe(1)
    })
    it('submits one validated candidate for repeated publish clicks and supports schedules', async () => {
        const requests: Array<{ url: string; body: Record<string, unknown> }> = []
        const fixture = modelFixture(async (input, init) => {
            const body = JSON.parse(String(init?.body))
            requests.push({ url: String(input), body })
            return Response.json(modelEntry('one', requests.length + 1, body.draft?.data))
        })
        const formState = useEntryForm(fixture.resource)
        formState.form.setFieldValue('title', 'Candidate')
        await Promise.all([formState.publish(), formState.publish()])
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
            url: expect.stringContaining('/publish'),
            body: { expectedVersion: 1, draft: { data: { title: 'Candidate' } } },
        })
        formState.form.setFieldValue('title', 'Scheduled')
        await formState.schedule('2027-01-01T00:00:00Z')
        expect(requests[1]).toMatchObject({
            url: expect.stringContaining('/schedule'),
            body: { expectedVersion: 2, at: '2027-01-01T00:00:00.000Z', draft: { data: { title: 'Scheduled' } } },
        })
    })
})
