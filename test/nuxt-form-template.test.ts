import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { generatedRuntimeSource } from './nuxt-native-runtime'

import { createSiteAdminDescriptor, defineSiteAdminConfig, text } from '../packages/site-admin/src'
import type { SiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { useSiteAdminForm, type UseSiteAdminFormOptions } from '../packages/site-admin/src/form'
import { siteAdminNuxtFormTemplate } from '../packages/site-admin/src/nuxt/client-templates'
import { createSiteAdminManagementClient, SiteAdminClientError } from '../packages/site-admin/src/client'

type Controller = ReturnType<typeof useSiteAdminForm<Record<string, unknown>>>
type GeneratedForm = {
    (model: string, options?: Record<string, unknown>): Promise<Controller>
    (options: UseSiteAdminFormOptions<Record<string, unknown>>): Controller
}

const generatedForm = (
    models: () => Promise<SiteAdminDescriptor>,
    createForm: (options: UseSiteAdminFormOptions<Record<string, unknown>>) => Controller = useSiteAdminForm,
): GeneratedForm => {
    const compiled = generatedRuntimeSource(siteAdminNuxtFormTemplate())
    const asyncData = <Value>(handler: () => Promise<Value>) => {
        const data = Vue.shallowRef<Value>()
        const error = Vue.shallowRef<unknown>()
        return Object.assign(
            handler().then(
                (value) => {
                    data.value = value
                },
                (cause: unknown) => {
                    error.value = cause
                },
            ),
            { data, error },
        )
    }
    const dependencies = {
        createForm,
        siteAdminManagementClientOptions: () => ({ basePath: '/manage', origin: 'http://localhost' }),
        createNuxtSiteAdminManagementClient: () => ({
            models,
            assetUrl: (id: string) => '/manage/assets/' + id + '/content',
        }),
        createSiteAdminManagementClient,
        SiteAdminClientError,
        useSiteAdminAuthScope: () => Vue.ref('actor'),
        useSiteAdminModels: () => asyncData(models),
        siteAdminReadModels: async (
            modelsState: ReturnType<typeof asyncData<SiteAdminDescriptor>>,
            _auth: unknown,
            signal: AbortSignal,
        ) => {
            await modelsState
            signal.throwIfAborted()
            if (modelsState.error.value) throw modelsState.error.value
            return modelsState.data.value!
        },
        siteAdminAsyncData: (
            _key: unknown,
            handler: (_app: unknown, context: { signal: AbortSignal }) => Promise<unknown>,
        ) => asyncData(() => handler({}, { signal: new AbortController().signal })),
        siteAdminManagementKey: () => 'test-key',
        useState: (_key: string, initialize: () => unknown) => Vue.ref(initialize()),
        useNuxtApp: () => ({ runWithContext: (callback: () => unknown) => callback(), hook: () => () => {} }),
        Vue,
    }
    return new Function(...Object.keys(dependencies), `${compiled}\nreturn useSiteAdminForm`)(
        ...Object.values(dependencies),
    ) as GeneratedForm
}

interface Node {
    children: Node[]
    parent: Node | null
    text?: string
}

const node = (value?: string): Node => ({ children: [], parent: null, ...(value === undefined ? {} : { text: value }) })
const renderer = Vue.createRenderer<Node, Node>({
    createComment: node,
    createElement: () => node(),
    createText: node,
    insert: (child, parent, anchor) => {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
        child.parent = parent
        const index = anchor ? parent.children.indexOf(anchor) : -1
        if (index < 0) parent.children.push(child)
        else parent.children.splice(index, 0, child)
    },
    nextSibling: (child) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    parentNode: (child) => child.parent,
    patchProp: () => {},
    remove: (child) => {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1)
        child.parent = null
    },
    setElementText: (element, value) => {
        element.text = value
    },
    setText: (textNode, value) => {
        textNode.text = value
    },
})

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Vue.nextTick()
}

const descriptor = createSiteAdminDescriptor(
    defineSiteAdminConfig({
        models: { posts: { fields: { title: text({ default: 'Authorized default', required: true }) } } },
    }),
)

describe('generated Nuxt form', () => {
    it('loads actor-filtered descriptors and initializes TanStack inside the owning component lifecycle', async () => {
        let controller: Controller | undefined
        let mounted = 0
        let unmounted = 0
        let formMounted = 0
        let formUnmounted = 0
        const models = vi.fn(async () => descriptor)
        const createForm = vi.fn((options: UseSiteAdminFormOptions<Record<string, unknown>>) => {
            expect(Vue.getCurrentInstance()).not.toBeNull()
            Vue.onMounted(() => {
                mounted += 1
            })
            Vue.onUnmounted(() => {
                unmounted += 1
            })
            const result = useSiteAdminForm(options)
            const form = result.form as typeof result.form & { mount: () => () => void }
            const mount = form.mount.bind(form)
            form.mount = () => {
                formMounted += 1
                const unmount = mount()
                return () => {
                    formUnmounted += 1
                    unmount()
                }
            }
            return result
        })
        const useGeneratedForm = generatedForm(models, createForm)
        const app = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                controller = await useGeneratedForm('posts')
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        app.mount(node())
        await flush()
        expect(models).toHaveBeenCalledOnce()
        expect(createForm).toHaveBeenCalledOnce()
        expect(controller?.form.state.values).toEqual({ title: 'Authorized default' })
        expect(mounted).toBe(1)
        expect(formMounted).toBe(1)
        expect(Vue.getCurrentInstance()).toBeNull()
        app.unmount()
        expect(unmounted).toBe(1)
        expect(formUnmounted).toBe(1)
        expect(Vue.getCurrentInstance()).toBeNull()
    })

    it.each(['posts', 'constructor', '__proto__'])(
        'does not create a form or expose defaults for unavailable model %s',
        async (modelName) => {
            const createForm = vi.fn(useSiteAdminForm<Record<string, unknown>>)
            const useGeneratedForm = generatedForm(async () => ({ assets: false, models: {} }), createForm)
            let failure: unknown
            const app = renderer.createApp({
                render: () =>
                    Vue.h(Vue.Suspense, null, {
                        default: () =>
                            Vue.h({
                                async setup() {
                                    try {
                                        await useGeneratedForm(modelName)
                                    } catch (error) {
                                        failure = error
                                    }
                                    return () => Vue.h('div')
                                },
                            }),
                    }),
            })
            app.mount(node())
            await flush()
            expect(failure).toBeInstanceOf(Error)
            expect((failure as Error).message).toContain('unavailable to this actor')
            expect(createForm).not.toHaveBeenCalled()
            expect(Vue.getCurrentInstance()).toBeNull()
            app.unmount()
        },
    )

    it('restores and cleans component context when the management request fails', async () => {
        const cause = new Error('Authentication required.')
        const useGeneratedForm = generatedForm(async () => {
            throw cause
        })
        let failure: unknown
        const app = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                try {
                                    await useGeneratedForm('posts')
                                } catch (error) {
                                    failure = error
                                }
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        app.mount(node())
        await flush()
        expect(failure).toBe(cause)
        expect(Vue.getCurrentInstance()).toBeNull()
        app.unmount()
    })

    it('preserves the synchronous options overload without a descriptor request', () => {
        const models = vi.fn(async () => descriptor)
        const expected = {} as Controller
        const createForm = vi.fn(() => expected)
        const useGeneratedForm = generatedForm(models, createForm)
        const actual = useGeneratedForm({ descriptor: descriptor.models.posts!, modelName: 'posts' })
        expect(actual).toBe(expected)
        expect(actual).not.toBeInstanceOf(Promise)
        expect(models).not.toHaveBeenCalled()
        expect(createForm).toHaveBeenCalledWith(
            expect.objectContaining({ managementBase: '/manage', modelName: 'posts' }),
        )
    })
})
