import { expect, it } from 'vitest'
import { createSSRApp, getCurrentInstance, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useEntryForm } from '../packages/site-admin/src/form'
import { modelFixture } from './model-fixture'

it('creates the native form synchronously in its owning component without another descriptor request', async () => {
    let calls = 0
    const { resource } = modelFixture(async () => {
        calls++
        throw new Error('No form fetch')
    })
    const html = await renderToString(
        createSSRApp({
            setup() {
                const instance = getCurrentInstance()
                const formState = useEntryForm(resource)
                expect(getCurrentInstance()).toBe(instance)
                expect(formState.form.Field).toBeDefined()
                return () => h('div', String(formState.form.state.values.title))
            },
        }),
    )
    expect(html).toBe('<div>Initial</div>')
    expect(calls).toBe(0)
})
