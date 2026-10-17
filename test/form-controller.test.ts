import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import {
    array,
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
import { presentSiteAdminData, serializeSiteAdminData } from '../packages/site-admin/src/management-assets'
import { useEntryForm } from '../packages/site-admin/src/form'
import { modelFixture } from './model-fixture'

const config = defineSiteAdminConfig({
    models: {
        posts: {
            displayFields: { description: 'summary', title: 'title' },
            fields: {
                slug: text(),
                title: text({ required: true }),
                copy: markdown(),
                summary: text(),
                image: image(),
                attachment: file(),
                gallery: images(),
                sections: array(
                    object({
                        asset: image(),
                        href: url(),
                        gallery: images(),
                        children: array(object({ asset: image() })),
                    }),
                ),
            },
        },
    },
})
const descriptor = createSiteAdminDescriptor(config).models.posts!
type Data = InferSiteAdminFormModels<typeof config>['posts']
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
})

it('normalizes multiple uploads into presented fields and serializes only declared asset properties', async () => {
    const calls: string[] = []
    const fixture = modelFixture(async (input) => {
        calls.push(String(input))
        return Response.json({ id: 'asset-' + calls.length })
    })
    const formState = useEntryForm(fixture.resource)
    await formState.upload('gallery', [new File(['a'], 'a.png'), new File(['b'], 'b.png')])
    const snapshot = formState.draft.snapshot()
    expect(snapshot.draft.gallery).toEqual([{ id: 'asset-1' }, { id: 'asset-2' }])
    expect((formState.form.state.values.gallery as Array<{ url: string }>)[0]?.url).toContain('/assets/asset-1/content')
})

it('uploads through nested arrays and appends nested galleries using native form paths', async () => {
    const request = vi.fn(async () => Response.json({ id: 'asset-' + request.mock.calls.length }))
    const fixture = modelFixture(request, undefined, {}, { model: 'posts', descriptor })
    const onUpload = vi.fn()
    const editor = useEntryForm(fixture.resource, { onUpload })
    editor.form.setFieldValue('sections', [{ asset: { id: 'existing' }, gallery: [{ id: 'kept' }], children: [{}] }])
    await editor.upload('sections[0].children[0].asset', new File(['a'], 'a.png'))
    await editor.upload('sections[0].gallery', [new File(['b'], 'b.png'), new File(['c'], 'c.png')])
    expect(editor.draft.snapshot().draft.sections).toEqual([
        {
            asset: { id: 'existing' },
            children: [{ asset: { id: 'asset-1' } }],
            gallery: [{ id: 'kept' }, { id: 'asset-2' }, { id: 'asset-3' }],
        },
    ])
    expect(onUpload.mock.calls.map(([context]) => context.field)).toEqual([
        'sections[0].children[0].asset',
        'sections[0].gallery',
    ])
    expect(editor.operation.value).toBeNull()
    expect(fixture.state.error.value).toBeUndefined()
})

it.each([
    'sections[2].asset',
    'sections[-1].asset',
    'sections[0].href',
    'sections[0].missing',
    'sections[0].__proto__.asset',
    'sections[0].asset.extra',
    'sections[0]asset',
])('rejects invalid asset path %s before uploading', async (path) => {
    const request = vi.fn(async () => Response.json({ id: 'wrong' }))
    const fixture = modelFixture(request, undefined, {}, { model: 'posts', descriptor })
    const editor = useEntryForm(fixture.resource)
    editor.form.setFieldValue('sections', [{ asset: { id: 'existing' } }])
    expect(await editor.upload(path, new File(['x'], 'x.png'))).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    expect(fixture.state.error.value?.data?.code).toBe('SITE_ADMIN_INVALID_INPUT')
    expect(editor.draft.snapshot().draft.sections).toEqual([{ asset: { id: 'existing' } }])
})

it.each(['remove', 'move', 'replace'] as const)(
    'keeps the current rows when an upload target is changed by %s',
    async (change) => {
        const reply = Promise.withResolvers<Response>()
        const request = vi.fn(() => reply.promise)
        const fixture = modelFixture(request, undefined, {}, { model: 'posts', descriptor })
        const editor = useEntryForm(fixture.resource)
        editor.form.setFieldValue('sections', [{ asset: { id: 'first' } }, { asset: { id: 'second' } }])
        const upload = editor.upload('sections[0].asset', new File(['x'], 'x.png'))
        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
        const rows = editor.form.state.values.sections as Array<{ asset: { id: string } }>
        editor.form.setFieldValue(
            'sections',
            change === 'remove' ? rows.slice(1) : change === 'move' ? [rows[1], rows[0]] : [{ ...rows[0] }, rows[1]],
        )
        const unchanged = editor.draft.snapshot()
        reply.resolve(Response.json({ id: 'wrong-row' }))
        expect(await upload).toBeUndefined()
        expect(editor.draft.snapshot()).toEqual(unchanged)
        expect(fixture.state.error.value?.data?.code).toBe('SITE_ADMIN_CONFLICT')
        expect(editor.operation.value).toBeNull()
    },
)

it('passes cancellation to uploads and retains the existing asset after failure or disposal', async () => {
    let signal: AbortSignal | null | undefined
    const reply = Promise.withResolvers<Response>()
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal
        return reply.promise
    })
    const fixture = modelFixture(request, undefined, {}, { model: 'posts', descriptor })
    const scope = effectScope()
    const editor = scope.run(() => useEntryForm(fixture.resource))!
    editor.form.setFieldValue('sections', [{ asset: { id: 'existing' } }])
    const upload = editor.upload('sections[0].asset', new File(['x'], 'x.png'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    fixture.identity.value = 'another-form'
    expect(signal?.aborted).toBe(true)
    reply.resolve(Response.json({ id: 'cancelled' }))
    expect(await upload).toBeUndefined()
    expect(editor.draft.snapshot().draft.sections).toBeUndefined()
    editor.form.setFieldValue('sections', [{ asset: { id: 'existing' } }])
    request.mockRejectedValueOnce(new Error('Upload failed'))
    expect(await editor.upload('sections[0].asset', new File(['y'], 'y.png'))).toBeUndefined()
    expect(editor.draft.snapshot().draft.sections).toEqual([{ asset: { id: 'existing' } }])
    scope.stop()
    expect(await editor.upload('sections[0].asset', new File(['z'], 'z.png'))).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
})
