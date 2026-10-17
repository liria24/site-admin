import { createSiteAdminDescriptor } from '../packages/site-admin/src/descriptor'
import { ref, shallowRef } from 'vue'
import { defineSiteAdminConfig, image, images, object, select, text } from '../packages/site-admin/src'
import { createSiteAdminManagementClient, type SiteAdminEntry } from '../packages/site-admin/src/client'
import {
    createSiteAdminModel,
    type SiteAdminModelState,
    type SiteAdminSessionDraft,
    type EntryPrepareContext,
} from '../packages/site-admin/src/model'
import type { ModelDescriptor } from '../packages/site-admin/src/descriptor'

export const formConfig = defineSiteAdminConfig({
    models: {
        posts: {
            sortable: true,
            fields: {
                slug: text(),
                title: text({ required: true, minLength: 1 }),
                optional: text(),
                image: image(),
                gallery: images(),
                publication: object({ slug: select(['auto', 'manual']) }),
            },
        },
    },
})
export const formDescriptor = createSiteAdminDescriptor(formConfig).models.posts!
export const modelEntry = (
    id = 'one',
    version = 1,
    data: Record<string, unknown> = { title: 'Initial' },
): SiteAdminEntry => ({
    id,
    version,
    model: 'posts',
    data,
    locale: '',
    defaultLocale: '',
    translations: {},
    createdAt: '',
    updatedAt: '',
    currentRevisionId: 'revision',
    revisionId: 'revision',
    publishedRevisionId: null,
    publishedAt: null,
    scheduledAt: null,
    scheduledRevisionId: null,
    sortOrder: null,
})
export const modelFixture = (
    request: typeof fetch,
    initial: SiteAdminEntry | null = modelEntry(),
    drafts: Record<string, SiteAdminSessionDraft> = {},
    options: {
        model: string
        descriptor: ModelDescriptor
        defaultLocale?: string
        prepare?: (context: EntryPrepareContext) => Promise<void>
    } = { model: 'posts', descriptor: formDescriptor },
) => {
    const identity = ref('alice:posts:' + (initial?.id ?? 'new'))
    const id = ref(initial?.id ?? null)
    const state: SiteAdminModelState<Record<string, unknown>> = {
        data: shallowRef(initial),
        status: ref('success'),
        error: shallowRef(),
        refresh: async () => {},
    }
    const client = createSiteAdminManagementClient<Record<string, Record<string, unknown>>>({
        origin: 'http://site.test',
        fetch: request,
    })
    const actions = createSiteAdminModel(state, {
        model: options.model,
        ...(options.defaultLocale ? { defaultLocale: options.defaultLocale } : {}),
        id,
        identity,
        descriptor: shallowRef(options.descriptor),
        locale: ref(undefined),
        client,
        drafts,
        ...(options.prepare ? { prepare: options.prepare } : {}),
    })
    return { state, resource: Object.assign(state, actions), client, identity, id, drafts }
}
