import { defineEventHandler } from 'nuxt/server'
import { useSiteAdmin } from '@liria24/site-admin/nuxt/server'

export default defineEventHandler(async () => (await useSiteAdmin()).publishDue())
