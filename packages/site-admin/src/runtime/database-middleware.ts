import { defineEventHandler } from 'nuxt/server'
import { useSiteAdminRuntime } from '../nuxt/server'

export default defineEventHandler(async (event) => {
    await useSiteAdminRuntime().initializeRequest?.(event)
})
