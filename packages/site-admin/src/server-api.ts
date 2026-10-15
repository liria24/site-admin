import type { RequestEvent } from 'nuxt/server'
import { createAdminClient } from './admin-client'
import {
    createSiteAdminClient,
    createSiteAdminManagementClient,
    type SiteAdminNamedAiActions,
    type SiteAdminFormModels,
} from './client'
import { SiteAdminError } from './errors'
import { handleManagementRequest, handlePublicRequest } from './server/http'
import { useSiteAdminRuntime } from './nuxt/server'

/** Capture the event now; resolve database bindings only when an operation needs them. */
export const useAdmin = (event?: RequestEvent, platformContext?: object) => {
    const runtime = useSiteAdminRuntime()
    const instance = () => runtime.getSiteAdmin(event, platformContext)
    const origin = event ? new URL(event.req.url).origin : 'http://site-admin.local'
    const raw = createSiteAdminManagementClient<SiteAdminFormModels>({
        origin,
        basePath: runtime.managementBase,
        fetch: async (url, init) => {
            if (!event)
                throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'Management operations require a request event.')
            const request = new Request(url, init)
            for (const name of ['cookie', 'authorization']) {
                const value = event.req.headers.get(name)
                if (value) request.headers.set(name, value)
            }
            return handleManagementRequest(await instance(), request, runtime.managementBase, event)
        },
    })
    const content = createSiteAdminClient({
        origin,
        basePath: runtime.publicBase,
        fetch: async (url, init) => handlePublicRequest(await instance(), new Request(url, init), runtime.publicBase),
    })
    const task = async (kind: 'publishDue' | 'collectAssets' | 'syncAssets', now?: Date) => {
        const admin = await instance()
        if (event) {
            const actor = await admin.authorizeRequest(event.req, event)
            if (kind === 'publishDue') admin.assertPermission(actor, 'system', 'publishDue')
            else admin.assertPermission(actor, 'asset', 'gc')
        }
        if (kind === 'publishDue') return admin.publishDue(now)
        if (kind === 'collectAssets') return admin.runAssetGC()
        return admin.syncAssetCopies()
    }
    return {
        ...createAdminClient(raw),
        ai: {
            run: async <Name extends Extract<keyof SiteAdminNamedAiActions, string>>(
                name: Name,
                input: SiteAdminNamedAiActions[Name]['input'],
            ): Promise<SiteAdminNamedAiActions[Name]['data']> => {
                if (!event) throw new SiteAdminError('SITE_ADMIN_AUTH_REQUIRED', 'AI actions require a request event.')
                if (!runtime.runAiAction)
                    throw new SiteAdminError('SITE_ADMIN_AI_UNAVAILABLE', 'AI actions are unavailable.')
                return (await runtime.runAiAction(event, name, { input })) as SiteAdminNamedAiActions[Name]['data']
            },
        },
        content: { list: content.list, get: content.get, resolve: content.resolveRoute },
        tasks: {
            publishDue: async (now?: Date) =>
                (await task('publishDue', now)) as import('./server/types').PublishDueResult,
            collectAssets: async () => (await task('collectAssets')) as import('./client').SiteAdminAssetGCResult,
            syncAssets: async () => (await task('syncAssets')) as import('./server/types').AssetSyncResult,
        },
    }
}
