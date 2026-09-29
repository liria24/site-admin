import { eventHandler, sendWebResponse, toWebRequest } from 'h3'
import { SiteAdminError } from '../errors'
import type { FieldDescriptor } from '../descriptor'
import { useSiteAdminRuntime } from '../server/runtime'

const fields = (source: Record<string, FieldDescriptor>): unknown =>
    Object.fromEntries(
        Object.entries(source).map(([name, field]) => [
            name,
            {
                kind: field.kind,
                required: field.required,
                relation: field.model,
                ...(field.fields ? { fields: fields(field.fields) } : {}),
                ...(field.item ? { item: fields({ item: field.item }) } : {}),
            },
        ]),
    )

export default eventHandler(async (event) => {
    const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
    let authorized = false
    try {
        const { getSiteAdmin, development } = useSiteAdminRuntime()
        const siteAdmin = await getSiteAdmin(event)
        const actor = await siteAdmin.authorizeRequest(toWebRequest(event), event)
        siteAdmin.assertPermission(actor, 'system', 'diagnostics')
        authorized = true
        const descriptor = siteAdmin.descriptorFor(actor)
        const models = Object.fromEntries(
            Object.entries(descriptor.models).map(([name, model]) => [
                name,
                {
                    ...model,
                    localized: siteAdmin.config.models[name]?.localized ?? false,
                    fields: fields(model.fields),
                },
            ]),
        )
        const [inspection, routes, entries] = await Promise.all([
            siteAdmin.inspect(),
            siteAdmin.routeSnapshot(),
            siteAdmin.listEntries(),
        ])
        const allowed = new Set(Object.keys(models))
        return sendWebResponse(
            event,
            Response.json(
                {
                    models,
                    database: { ...development, schemaReady: true },
                    assets: {
                        ...inspection.assets,
                        orphanCount: inspection.orphanAssets,
                        storage: siteAdmin.config.assets?.storage,
                        cleanup: { minimumAge: siteAdmin.config.assets?.cleanup?.minimumAge ?? 86400 },
                        operationLeaseSeconds: siteAdmin.config.assets?.operationLeaseSeconds ?? 900,
                    },
                    routes: routes.filter((route) =>
                        entries.some((entry) => allowed.has(entry.model) && entry.id === route.entryId),
                    ),
                    revisions: entries
                        .filter((entry) => allowed.has(entry.model))
                        .map((entry) => ({
                            id: entry.id,
                            model: entry.model,
                            locale: entry.locale,
                            current: entry.currentRevisionId,
                            published: entry.publishedRevisionId,
                            scheduled: entry.scheduledRevisionId,
                        })),
                    diagnostics: [...new Set(inspection.diagnostics.map((item) => item.code))].map((code) => ({
                        code,
                        hint: 'Check the current Model definition, field validation and referenced entries/assets.',
                    })),
                },
                { headers },
            ),
        )
    } catch (error) {
        if (authorized && error instanceof SiteAdminError && error.code === 'SITE_ADMIN_MIGRATION_REQUIRED') {
            return sendWebResponse(
                event,
                Response.json(
                    {
                        database: { ...useSiteAdminRuntime().development, schemaReady: false },
                        diagnostics: [
                            {
                                code: error.code,
                                hint: 'Run site-admin generate, review drizzle-kit generate output and explicitly apply the migrations.',
                            },
                        ],
                    },
                    { headers },
                ),
            )
        }
        return sendWebResponse(
            event,
            Response.json(
                { error: error instanceof SiteAdminError ? error.code : 'SITE_ADMIN_INSPECTION_FAILED' },
                { status: error instanceof SiteAdminError ? error.status : 500, headers },
            ),
        )
    }
})
