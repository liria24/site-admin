import { SiteAdminError } from '../errors'
import type { SiteAdmin } from '../server/site-admin'

/** `true` enables manual runs; a cron string additionally enables its Nitro schedule. */
export interface SiteAdminTaskOptions {
    publishDue?: boolean | string
    assetGC?: boolean | string
    syncAssets?: boolean | string
}

export type SiteAdminTaskName = keyof SiteAdminTaskOptions

type TaskSiteAdmin = Pick<SiteAdmin, 'publishDue' | 'runAssetGC' | 'syncAssetCopies'>

export interface SiteAdminTaskRuntime {
    tasks?: SiteAdminTaskOptions
    getSiteAdmin(event?: undefined, platformContext?: object): TaskSiteAdmin | Promise<TaskSiteAdmin>
}

/** Run existing use cases without changing their revision, ownership, lease, or conflict handling. */
export const runSiteAdminTask = async (
    name: SiteAdminTaskName,
    runtime: SiteAdminTaskRuntime,
    platformContext?: object,
) => {
    const enabled = runtime.tasks?.[name]
    if (enabled !== true && !(typeof enabled === 'string' && enabled.trim()))
        throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', `Site Admin task "${name}" is disabled.`)
    const admin = await runtime.getSiteAdmin(undefined, platformContext)
    switch (name) {
        case 'publishDue':
            return admin.publishDue()
        case 'assetGC':
            return admin.runAssetGC()
        case 'syncAssets':
            return admin.syncAssetCopies()
    }
}
