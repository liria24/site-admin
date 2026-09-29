import { connectDevframe } from 'devframe/client'

const status = document.querySelector<HTMLElement>('#status')!
const output = document.querySelector<HTMLElement>('#snapshot')!
let diagnostics: unknown = null
let bridge: Awaited<ReturnType<typeof connectDevframe>> | undefined
let pending = false
let failed = false
async function refresh(): Promise<void> {
    if (pending) return
    pending = true
    status.textContent = 'Loading…'
    try {
        const response = await fetch('./snapshot', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok)
            throw new Error(
                `Snapshot unavailable (${response.status}). Sign in with diagnostics permission and check migrations.`,
            )
        const snapshot = await response.json()
        diagnostics = snapshot.diagnostics
        failed = snapshot.database?.schemaReady === false
        if (failed) bridge?.scope('site-admin').rpc.callEvent('report-failure')
        output.textContent = JSON.stringify(snapshot, null, 2)
        status.textContent = 'Snapshot loaded. Refresh manually after changes.'
    } catch (error) {
        failed = true
        output.textContent = ''
        diagnostics = null
        status.textContent = error instanceof Error ? error.message : 'Snapshot unavailable.'
        bridge?.scope('site-admin').rpc.callEvent('report-failure')
    } finally {
        pending = false
    }
}
async function copy(): Promise<void> {
    try {
        await navigator.clipboard.writeText(
            JSON.stringify(
                diagnostics ?? { message: 'Snapshot unavailable; check authentication and migrations.' },
                null,
                2,
            ),
        )
        status.textContent = 'Diagnostics copied (no content or connection credentials).'
    } catch {
        status.textContent = 'Clipboard unavailable.'
    }
}
document.querySelector('#refresh')!.addEventListener('click', () => void refresh())
document.querySelector('#copy')!.addEventListener('click', () => void copy())
void connectDevframe({ simpleAuth: false })
    .then((value) => {
        bridge = value
        if (failed) value.scope('site-admin').rpc.callEvent('report-failure')
        const rpc = value.scope('site-admin').rpc
        rpc.register({ name: 'refresh', type: 'event', handler: () => void refresh() })
        rpc.register({ name: 'copy-diagnostics', type: 'event', handler: () => void copy() })
    })
    .catch(() => {
        /* DevTools v3 uses the same UI without an RPC host. */
    })
void refresh()
