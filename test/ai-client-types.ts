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
    // @ts-expect-error Retired metadata callbacks are no longer exposed.
    client.generateMetadata('articles', { data: {}, generate: {} })
    // @ts-expect-error Retired entry callbacks are no longer exposed.
    client.runAIAction('id', 'publication', {})
    // @ts-expect-error Retired proofreading callbacks are no longer exposed.
    client.proofreadDraft('articles', { data: {} })
}
void checkAIClientTypes
