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
    void [excerpt, slug, body, guaranteedTitle]
}
void checkAIClientTypes
