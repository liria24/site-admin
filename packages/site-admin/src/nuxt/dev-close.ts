import type { Nitro } from 'nitropack/types'

export function stopNitroDevReloadOnClose(instance: unknown): void {
    const nitro = instance as Pick<Nitro, 'hooks'> | undefined
    if (typeof nitro?.hooks?.callHookWith !== 'function') return
    // Nitro 2 can finish a Rollup build during close and respawn a worker that
    // keeps Vite's IPC server open. Unsubscribe reload handlers before workers close.
    nitro.hooks.hook('close', () => {
        nitro.hooks.callHookWith((callbacks) => {
            for (const callback of callbacks) nitro.hooks.removeHook('dev:reload', callback)
        }, 'dev:reload')
    })
}
