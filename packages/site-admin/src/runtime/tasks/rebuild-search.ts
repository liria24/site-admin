import { defineTask } from 'nitropack/runtime'
import { useSiteAdminRuntime } from '../../nuxt/server'
import { runSiteAdminTask } from '../tasks'
export default defineTask({
    meta: {
        name: 'site-admin:rebuild-search',
        description: 'Rebuild the content search index after an explicit migration.',
    },
    run: async ({ context }) => ({ result: await runSiteAdminTask('rebuildSearch', useSiteAdminRuntime(), context) }),
})
