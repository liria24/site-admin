import { defineEventHandler } from 'nuxt/server'
import { aiCalls } from '../ai-model'
export default defineEventHandler(() => ({ count: aiCalls }))
