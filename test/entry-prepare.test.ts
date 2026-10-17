import { expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useEntryForm } from '../packages/site-admin/src/form'
import { formDescriptor, modelEntry, modelFixture } from './model-fixture'

it('retains a clean new draft identity after preparation failure and clears it after final success', async () => {
    let version = 0
    const calls: string[] = []
    const onSuccess = vi.fn()
    let fail = true
    const fixture = modelFixture(
        async (input, init) => {
            calls.push(String(input))
            const body = JSON.parse(String(init?.body))
            return Response.json(modelEntry('persisted', ++version, body.draft?.data ?? body.data))
        },
        null,
        {},
        {
            model: 'posts',
            descriptor: formDescriptor,
            prepare: async (context) => {
                if (context.operation === 'save') return
                if (fail) throw new Error('Application preparation failed')
                context.value.slug = 'app-value'
            },
        },
    )
    const { form, publish, draft } = useEntryForm(fixture.resource, { defaultValues: { title: 'New' }, onSuccess })
    expect(draft.isDirty.value).toBe(false)
    expect(await publish()).toBeUndefined()
    expect(draft.snapshot()).toMatchObject({ entryId: 'persisted', version: 1 })
    expect(Object.values(fixture.drafts)).toMatchObject([{ entryId: 'persisted', pendingPublication: true }])
    expect(onSuccess).not.toHaveBeenCalled()
    expect(form.state.values).not.toHaveProperty('slug')
    fail = false
    await publish()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('/persisted/publish')
    expect(form.state.values.slug).toBe('app-value')
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(fixture.drafts).toEqual({})
})

it('aborts application preparation on scope disposal without sending the candidate', async () => {
    const scope = effectScope()
    const started = Promise.withResolvers<AbortSignal>()
    const prepared = Promise.withResolvers<void>()
    const request = vi.fn(async () => Response.json(modelEntry()))
    const editor = scope.run(() =>
        useEntryForm(
            modelFixture(
                request,
                modelEntry(),
                {},
                {
                    model: 'posts',
                    descriptor: formDescriptor,
                    prepare: async ({ signal }) => {
                        started.resolve(signal)
                        await prepared.promise
                    },
                },
            ).resource,
        ),
    )!
    const publishing = editor.publish()
    const signal = await started.promise
    scope.stop()
    expect(signal.aborted).toBe(true)
    prepared.resolve()
    await publishing
    expect(request).not.toHaveBeenCalled()
})
