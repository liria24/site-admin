import { expect, it } from 'vitest'
import { nextTick } from 'vue'
import { useEntryForm } from '../packages/site-admin/src/form'
import { modelEntry, modelFixture } from './model-fixture'

it('does not create a different entry when an existing resource has not loaded', async () => {
    let calls = 0
    const fixture = modelFixture(async () => {
        calls++
        return Response.json(modelEntry())
    })
    fixture.state.data.value = undefined
    await expect(fixture.resource.save({ slug: 'one', title: 'Draft' })).rejects.toMatchObject({
        data: { code: 'SITE_ADMIN_INVALID_INPUT' },
    })
    expect(calls).toBe(0)
})

it('deduplicates identical writes and serializes distinct writes with the latest version', async () => {
    const requests: Array<{ data: { title: string }; expectedVersion: number }> = []
    const fixture = modelFixture(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as (typeof requests)[number]
        requests.push(body)
        return Response.json(modelEntry('one', body.expectedVersion + 1, body.data))
    })
    const a = fixture.resource.save({ slug: 'one', title: 'First' })
    const duplicate = fixture.resource.save({ slug: 'one', title: 'First' })
    const b = fixture.resource.save({ slug: 'one', title: 'Second' })
    expect(a).toBe(duplicate)
    await Promise.all([a, duplicate, b])
    expect(requests.map(({ expectedVersion }) => expectedVersion)).toEqual([1, 2])
    expect(fixture.state.data.value).toMatchObject({ version: 3, data: { title: 'Second' } })
})

it('preserves submitted input and identity when refreshing a committed create fails', async () => {
    let writes = 0
    const fixture = modelFixture(async (_input, init) => {
        writes++
        const body = JSON.parse(String(init?.body)) as { data: Record<string, unknown> }
        return Response.json(modelEntry('created', writes, body.data))
    }, null)
    fixture.state.refresh = async () => {
        throw new Error('Refresh unavailable')
    }
    const formState = useEntryForm(fixture.resource, { defaultValues: { title: 'Draft' } })
    await formState.form.handleSubmit()
    expect(writes).toBe(1)
    expect(fixture.resource.error.value?.data?.committed).toBe(true)
    expect(formState.draft.snapshot()).toMatchObject({ entryId: 'created', version: 1 })
    expect(formState.form.state.values.title).toBe('Draft')
    fixture.state.refresh = async () => {}
    formState.form.setFieldValue('title', 'Retry explicitly')
    await formState.form.handleSubmit()
    expect(writes).toBe(2)
    expect(fixture.resource.error.value).toBeUndefined()
    expect(formState.draft.snapshot().version).toBe(2)
})

it('rejects a mutation response with a stale version without replacing the draft', async () => {
    const fixture = modelFixture(async () => Response.json(modelEntry('one', 1)))
    const formState = useEntryForm(fixture.resource)
    formState.form.setFieldValue('title', 'Keep me')
    await formState.form.handleSubmit()
    expect(fixture.resource.error.value?.data).toMatchObject({ code: 'SITE_ADMIN_INVALID_RESPONSE', committed: true })
    expect(formState.form.state.values.title).toBe('Keep me')
    expect(formState.draft.snapshot().version).toBe(1)
})

it('restores sortable items after a failed reorder, including a UI that already moved its items', async () => {
    const fixture = modelFixture(async () =>
        Response.json({ error: { code: 'SITE_ADMIN_CONFLICT', message: 'Changed' } }, { status: 409 }),
    )
    const one = modelEntry('one'),
        two = modelEntry('two')
    fixture.state.data.value = { items: [one, two], total: 2, limit: 2, offset: 0 }
    await nextTick()
    await expect(fixture.resource.reorder([two, one])).rejects.toMatchObject({
        data: { code: 'SITE_ADMIN_CONFLICT' },
    })
    await nextTick()
    expect(
        (fixture.state.data.value && 'items' in fixture.state.data.value ? fixture.state.data.value.items : []).map(
            ({ id }) => id,
        ),
    ).toEqual(['one', 'two'])
    expect(fixture.resource.status.value).toBe('error')
})
