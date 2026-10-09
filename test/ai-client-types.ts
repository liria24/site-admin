import { defineSiteAdminConfig, markdown, text, textarea, type InferSiteAdminModels } from '../packages/site-admin/src'
import { createSiteAdminManagementClient } from '../packages/site-admin/src/client'

const config = defineSiteAdminConfig({
    models: {
        articles: {
            fields: { body: markdown(), excerpt: textarea({ required: true }), title: text({ required: true }) },
        },
    },
})

const checkAIClientTypes = async (): Promise<void> => {
    const client = createSiteAdminManagementClient<InferSiteAdminModels<typeof config>>()
    const candidate = { title: 'Typed publication', excerpt: 'Manual excerpt' }
    const published = await client.publishEntry('id', { expectedVersion: 1, draft: { data: candidate, slug: 'typed' } })
    if ('data' in published) {
        const title: string = published.data.title
        void title
    }
    const action = await client.runAIAction('id', 'application-action', {
        expectedVersion: 1,
        draft: { data: candidate },
    })
    const actionTitle: string = action.data.title
    await client.schedulePublish('id', { at: '2099-01-01T00:00:00Z', expectedVersion: 1, draft: { data: candidate } })
    // @ts-expect-error Schedule candidates and revision selection are mutually exclusive too.
    await client.schedulePublish('id', {
        at: '2099-01-01T00:00:00Z',
        expectedVersion: 1,
        revisionId: 'revision',
        draft: { data: candidate },
    })
    // @ts-expect-error Public candidate and revision selection are mutually exclusive.
    await client.publishEntry('id', { expectedVersion: 1, revisionId: 'revision', draft: { data: candidate } })
    // @ts-expect-error Candidate data preserves configured field value types.
    await client.publishEntry('id', { expectedVersion: 1, draft: { data: { title: 1, excerpt: '' } } })
    // @ts-expect-error An unsaved action snapshot requires its expected version.
    await client.runAIAction('id', 'application-action', { draft: { data: candidate } })
    await client.runAIAction('id', 'application-action', {
        expectedVersion: 1,
        // @ts-expect-error An action snapshot preserves configured field types.
        draft: { data: { title: 1, excerpt: '' } },
    })
    const metadata = await client.generateMetadata('articles', {
        data: { title: 'Incomplete draft' },
        generate: { excerpt: true, slug: true },
    })
    const excerpt: string | undefined = metadata.data.excerpt
    const slug: string | undefined = metadata.slug
    const proofread = await client.proofreadDraft('articles', { data: { body: 'Draf' }, fields: ['body'] })
    const body: string | null | undefined = proofread.data.body
    // @ts-expect-error An unsaved proposal can still be incomplete and have validation issues.
    const guaranteedTitle: string = metadata.data.title
    // @ts-expect-error Unknown configured model names must fail.
    await client.generateMetadata('missing', { data: {}, generate: {} })
    // @ts-expect-error Wrong draft field value types must fail.
    await client.generateMetadata('articles', { data: { title: 1 }, generate: {} })
    // @ts-expect-error Metadata generation flags must be selected explicitly.
    await client.generateMetadata('articles', { data: {} })
    // @ts-expect-error Proofreading fields must be model field names.
    await client.proofreadDraft('articles', { data: {}, fields: ['missing'] })
    // @ts-expect-error Unknown model names must also fail through the generated management registry.
    await createSiteAdminManagementClient().generateMetadata('missing', { data: {}, generate: {} })
    // @ts-expect-error Unknown model names must also fail through the generated management registry.
    await createSiteAdminManagementClient().proofreadDraft('missing', { data: {} })
    void [excerpt, slug, body, guaranteedTitle, actionTitle]
}
void checkAIClientTypes
