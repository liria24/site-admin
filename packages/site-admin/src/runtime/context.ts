import { withRuntimeEnv } from 'void/_env'
import { AsyncLocalStorage } from 'node:async_hooks'

const contexts = new AsyncLocalStorage<object | undefined>()
export const currentSiteAdminContext = () => contexts.getStore()

/** Use Void's async scope for HTTP and scheduled operations, without rewriting global bindings. */
export const withSiteAdminContext = <Value>(context: object | undefined, run: () => Value): Value => {
    const source = context as { cloudflare?: { env?: unknown }; env?: unknown } | undefined
    return contexts.run(context, () => withRuntimeEnv(source?.cloudflare?.env ?? source?.env, run))
}
