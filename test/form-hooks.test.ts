import { expect, it, vi } from 'vitest'
import { effectScope, nextTick, type Ref } from 'vue'
import { useEntryForm } from '../packages/site-admin/src/form'
import { siteAdminModelContext } from '../packages/site-admin/src/model'
import { formDescriptor, modelEntry, modelFixture } from './model-fixture'

it('validates before hooks, coalesces quiet draft creation, and completes before success navigation', async () => {
    const order: string[] = []
    const fixture = modelFixture(async (_url, init) => {
        order.push('write')
        return Response.json(
            modelEntry(
                'created',
                (JSON.parse(String(init?.body)).expectedVersion ?? 0) + 1,
                JSON.parse(String(init?.body)).data,
            ),
        )
    }, null)
    const editor = useEntryForm(fixture.resource, {
        onBeforeSubmit: () => {
            order.push('before')
        },
        onSuccess: () => {
            order.push('success')
            expect(editor.operation.value).toBe(null)
        },
    })
    await editor.form.handleSubmit()
    expect(order).toEqual([])
    editor.form.setFieldValue('title', 'Valid')
    const [first, second] = await Promise.all([editor.draft.ensure(), editor.draft.ensure()])
    expect(first).toEqual({ id: 'created', version: 1 })
    expect(second).toEqual(first)
    expect(order).toEqual(['before', 'write'])
    await editor.form.handleSubmit()
    expect(order).toEqual(['before', 'write', 'before', 'write', 'success'])
})

it('runs upload hooks once after field updates, preserves successful results on hook failure, and skips empty/failed/disposed uploads', async () => {
    const upload = vi.fn(async () => Response.json({ id: 'image', contentType: 'image/png', size: 1 }))
    const fixture = modelFixture(upload)
    const scope = effectScope()
    const onUpload = vi.fn(() => {
        expect(editor.form.state.values.image).toMatchObject({ id: 'image' })
        throw new Error('Filename display failed')
    })
    const editor = scope.run(() => useEntryForm(fixture.resource, { onUpload }))!
    expect(await editor.upload('image', [])).toEqual([])
    expect(onUpload).not.toHaveBeenCalled()
    expect(await editor.upload('image', new File(['x'], 'image.png'))).toMatchObject([{ id: 'image' }])
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(fixture.state.error.value?.message).toBe('Filename display failed')
    upload.mockRejectedValueOnce(new Error('Upload failed'))
    expect(await editor.upload('image', new File(['y'], 'failed.png'))).toBeUndefined()
    expect(onUpload).toHaveBeenCalledTimes(1)
    const pending = Promise.withResolvers<Response>()
    upload.mockImplementationOnce(() => pending.promise)
    const request = editor.upload('image', new File(['z'], 'cancelled.png'))
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
    scope.stop()
    pending.resolve(Response.json({ id: 'cancelled', contentType: 'image/png', size: 1 }))
    expect(await request).toBeUndefined()
    expect(onUpload).toHaveBeenCalledTimes(1)
})

it('keeps fallback values sparse and unsaved inputs separate across locale changes', async () => {
    const original = {
        ...modelEntry('one', 1, { title: 'Original', optional: 'Shared' }),
        defaultLocale: 'ja',
        locale: 'ja',
    }
    const writes: Record<string, unknown>[] = []
    const descriptor = {
        ...formDescriptor,
        fields: { ...formDescriptor.fields, title: { ...formDescriptor.fields.title!, i18n: true } },
    }
    const fixture = modelFixture(
        async (_url, init) => {
            const input = JSON.parse(String(init?.body))
            writes.push(input)
            return Response.json({ ...original, version: 2, ...input })
        },
        original,
        {},
        { model: 'posts', descriptor },
    )
    const context = fixture.resource[siteAdminModelContext]
    const locale = context.locale as Ref<string>
    locale.value = 'en'
    fixture.identity.value =
        'site-admin-management:' + JSON.stringify(['origin', '/manage', 'alice', 'entry', 'posts', 'one', 'en'])
    const scope = effectScope()
    const editor = scope.run(() => useEntryForm(fixture.resource))!
    await editor.form.handleSubmit()
    expect(writes[0]).not.toHaveProperty('translations')
    fixture.state.data.value = { ...original, version: 2 }
    editor.form.setFieldValue('title', 'Unsaved English')
    const snapshot = editor.draft.snapshot()
    expect(editor.draft.isStale(snapshot)).toBe(false)
    locale.value = 'ja'
    fixture.identity.value =
        'site-admin-management:' + JSON.stringify(['origin', '/manage', 'alice', 'entry', 'posts', 'one', 'ja'])
    fixture.state.data.value = { ...original, version: 2 }
    await nextTick()
    expect(editor.form.state.values.title).toBe('Original')
    expect(editor.draft.isDirty.value).toBe(true)
    expect(editor.draft.isStale(snapshot)).toBe(true)
    locale.value = 'en'
    fixture.identity.value =
        'site-admin-management:' + JSON.stringify(['origin', '/manage', 'alice', 'entry', 'posts', 'one', 'en'])
    fixture.state.data.value = { ...original, version: 2 }
    await nextTick()
    expect(editor.form.state.values.title).toBe('Unsaved English')
    await editor.form.handleSubmit()
    expect(writes[1]).toMatchObject({
        data: { title: 'Original', optional: 'Shared' },
        translations: { en: { title: 'Unsaved English' } },
    })
    scope.stop()
})

it('rejects invalid schedules before preparation and stops on a failed before-submit hook', async () => {
    const request = vi.fn()
    const fixture = modelFixture(request)
    const before = vi.fn(() => {
        throw new Error('Review the suggestion')
    })
    const editor = useEntryForm(fixture.resource, { onBeforeSubmit: before })
    expect(await editor.schedule('invalid')).toBeUndefined()
    expect(before).not.toHaveBeenCalled()
    await editor.publish()
    expect(before).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(fixture.state.error.value?.message).toBe('Review the suggestion')
})

it('retains a committed new ID/version and later edits when file effects fail, without replaying the save', async () => {
    const response = Promise.withResolvers<Response>()
    const writes: Array<{ method: string; body: Record<string, unknown> }> = []
    const fixture = modelFixture(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        writes.push({ method: init!.method!, body })
        return writes.length === 1 ? response.promise : Response.json(modelEntry('created', 2, body.data))
    }, null)
    fixture.state.refresh = async () => {
        expect(fixture.id.value).toBe('created')
        fixture.state.data.value = modelEntry('created', 1, { title: 'Submitted' })
    }
    const success = vi.fn()
    const editor = useEntryForm(fixture.resource, { defaultValues: { title: 'Submitted' }, onSuccess: success })
    const pending = editor.form.handleSubmit()
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    editor.form.setFieldValue('title', 'Later')
    response.resolve(
        Response.json(
            {
                error: {
                    code: 'SITE_ADMIN_STORAGE_UNAVAILABLE',
                    message: 'Retry Asset synchronization only.',
                    committed: true,
                    receipt: { id: 'created', model: 'posts', version: 1 },
                    effects: { assets: 'pending' },
                },
            },
            { status: 503 },
        ),
    )
    await pending
    expect(fixture.id.value).toBe('created')
    expect(editor.draft.snapshot()).toMatchObject({ entryId: 'created', version: 1 })
    expect(editor.form.state.values.title).toBe('Later')
    expect(editor.draft.isDirty.value).toBe(true)
    expect(success).not.toHaveBeenCalled()
    expect(writes).toHaveLength(1)
    expect(fixture.state.error.value?.data).toMatchObject({ committed: true, effects: { assets: 'pending' } })
})

it('keeps saved state when the success callback fails', async () => {
    const fixture = modelFixture(async () => Response.json(modelEntry('one', 2, { title: 'Saved' })))
    const editor = useEntryForm(fixture.resource, {
        onSuccess: () => {
            throw new Error('Navigation callback failed')
        },
    })
    editor.form.setFieldValue('title', 'Saved')
    await editor.form.handleSubmit()
    expect(editor.operation.value).toBe(null)
    expect(editor.draft.snapshot()).toMatchObject({ version: 2 })
    expect(editor.draft.isDirty.value).toBe(false)
    expect(fixture.state.error.value?.data?.committed).toBe(true)
})

it('creates the original and edited locale buffers in one snapshot without persisting inherited fields', async () => {
    const writes: Record<string, unknown>[] = []
    const fixture = modelFixture(
        async (_url, init) => {
            const input = JSON.parse(String(init?.body))
            writes.push(input)
            return Response.json({ ...modelEntry('created'), ...input })
        },
        null,
        {},
        {
            model: 'posts',
            defaultLocale: 'ja',
            descriptor: {
                ...formDescriptor,
                fields: { ...formDescriptor.fields, title: { ...formDescriptor.fields.title!, i18n: true } },
            },
        },
    )
    const context = fixture.resource[siteAdminModelContext]
    const locale = context.locale as Ref<string>
    const identity = (language: string) =>
        'site-admin-management:' + JSON.stringify(['origin', '/manage', 'alice', 'entry', 'posts', null, language])
    locale.value = 'ja'
    fixture.identity.value = identity('ja')
    const scope = effectScope()
    const editor = scope.run(() => useEntryForm(fixture.resource))!
    editor.form.setFieldValue('title', '原本')
    editor.form.setFieldValue('optional', 'Shared')
    locale.value = 'en'
    fixture.identity.value = identity('en')
    await nextTick()
    expect(editor.form.state.values.title).toBe('原本')
    editor.form.setFieldValue('title', 'English')
    await editor.form.handleSubmit()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
        defaultLocale: 'ja',
        data: { title: '原本', optional: 'Shared' },
        translations: { en: { title: 'English' } },
    })
    expect(Object.keys(fixture.drafts)).toEqual([])
    scope.stop()
})
