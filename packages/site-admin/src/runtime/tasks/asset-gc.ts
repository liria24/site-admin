import { defineTask } from 'nitropack/runtime'
import { useSiteAdminRuntime } from '../../nuxt/server'
import { runSiteAdminTask } from '../tasks'

export default defineTask({
    meta: { name: 'site-admin:asset-gc', description: 'Collect unreferenced Site Admin assets.' },
    run: async ({ context }) => ({ result: await runSiteAdminTask('assetGC', useSiteAdminRuntime(), context) }),
})
