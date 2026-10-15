import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { describe, expect, it } from 'vitest'
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
                sections: array(object({ asset: image(), href: url() })),
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
