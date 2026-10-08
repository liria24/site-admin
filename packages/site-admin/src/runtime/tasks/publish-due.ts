import { defineTask } from 'nitropack/runtime'
import { useSiteAdminRuntime } from '../../nuxt/server'
import { runSiteAdminTask } from '../tasks'

export default defineTask({
    meta: { name: 'site-admin:publish-due', description: 'Publish due Site Admin revisions.' },
    run: async ({ context }) => ({ result: await runSiteAdminTask('publishDue', useSiteAdminRuntime(), context) }),
})
