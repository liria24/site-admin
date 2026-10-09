import type { SiteAdminClientTemplateOptions } from './client-templates'

/** Contains paths and type-only contracts, never providers, prompts or executable config. */
export const siteAdminNuxtAiTemplate = (options: SiteAdminClientTemplateOptions): string => `
import { createUseFetch } from '#app/composables/fetch'
import { defineUseFetchAddon } from '#app/composables/addons'
import { hashKey } from '#app'
import type { UseFetchOptions } from '#app/composables/fetch'
import type { AsyncDataMiddleware } from '#app/composables/asyncData'
import type { SiteAdminNamedAiActions } from '@liria24/site-admin/client'

// Nuxt owns hashing, SSR payload hydration, cancellation and AsyncData state.
export const siteAdminAiFetch = createUseFetch({
  method: 'post', watch: false, retry: 0, dedupe: 'defer',
  addons: [defineUseFetchAddon({
    setup: (options) => {
      Object.assign(options, { method: 'post', watch: false, retry: 0 })
      const abortMiddleware: AsyncDataMiddleware = async (next, { signal }) => {
        const key = toValue(options.key)
        // Public clear settles Nuxt 4.6's external-abort promise after transport cancellation.
        const abort = () => { if (signal.reason?.name === 'AbortError' && key) clearNuxtData(key) }
        signal.addEventListener('abort', abort, { once: true })
        try { return await next() } finally { signal.removeEventListener('abort', abort) }
      }
      options.middleware.push(abortMiddleware)
    },
  })],
})

type AiActionName = Extract<keyof SiteAdminNamedAiActions, string>
export type UseAiActionOptions<Name extends AiActionName> =
  Pick<UseFetchOptions<SiteAdminNamedAiActions[Name]['data']>, 'immediate' | 'server' | 'lazy' | 'timeout' | 'dedupe' | 'deep'> & {
    props: MaybeRefOrGetter<SiteAdminNamedAiActions[Name]['props']>
    authScope?: MaybeRefOrGetter<string>
  }

export function useAiAction<Name extends AiActionName>(name: Name, options: UseAiActionOptions<Name>) {
  const { props, authScope, ...nativeOptions } = options
  const scope = useSiteAdminAuthScope(authScope)
  const body = computed(() => ({ props: JSON.parse(JSON.stringify(toValue(props))) }))
  const path = ${JSON.stringify(options.managementBase.replace(/\/$/u, '') + '/ai/actions/')} + encodeURIComponent(name)
  const connection = siteAdminManagementClientOptions()
  const key = computed(() => 'site-admin-ai:' + hashKey([connection.origin, path, scope.value, body.value]))
  // Clear the previous identity before Nuxt's key watcher can carry private data forward.
  let previousScope = scope.value
  watch(key, (_next, previous) => {
    const authChanged = previousScope !== scope.value
    previousScope = scope.value
    if (authChanged) clearNuxtData(previous)
  }, { flush: 'sync' })
  return siteAdminAiFetch<SiteAdminNamedAiActions[Name]['data']>(
    path,
    { ...nativeOptions, key, body },
  )
}
`
