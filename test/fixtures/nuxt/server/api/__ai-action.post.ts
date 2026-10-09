import { defineEventHandler } from 'nuxt/server'
import { runAiAction } from '@liria24/site-admin/nuxt/server'
export default defineEventHandler((event) => runAiAction(event, 'proofread', { props: { content: 'Server helper' } }))
