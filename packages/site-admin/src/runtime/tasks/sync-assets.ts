import { defineTask } from 'nitropack/runtime'
import { useSiteAdminRuntime } from '../../nuxt/server'
import { runSiteAdminTask } from '../tasks'

export default defineTask({
    meta: { name: 'site-admin:sync-assets', description: 'Retry Site Admin draft/public asset synchronization.' },
    run: async ({ context }) => ({ result: await runSiteAdminTask('syncAssets', useSiteAdminRuntime(), context) }),
})
