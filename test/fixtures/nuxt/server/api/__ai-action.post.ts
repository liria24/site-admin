import { defineEventHandler } from 'nuxt/server'
import { useAdmin } from '@liria24/site-admin/server'
export default defineEventHandler((event) => useAdmin(event).ai.run('proofread', { content: 'Server helper' }))
