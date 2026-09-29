import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { addDevServerHandler, addServerHandler, getNuxtModuleVersion } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { eventHandler, setHeader } from 'h3'

export const DEVTOOLS_PATH = '/__site-admin-devtools/'

export async function setupSiteAdminDevtools(nuxt: Nuxt): Promise<void> {
    addServerHandler({
        route: `${DEVTOOLS_PATH}snapshot`,
        handler: fileURLToPath(new URL('../runtime/devtools-snapshot.js', import.meta.url)),
    })
    const version = await getNuxtModuleVersion('@nuxt/devtools', nuxt)
    if (Number.parseInt(version || '3') >= 4) {
        const { setupDock } = await import('./dock')
        setupDock(nuxt)
        return
    }
    const assets = new Map([
        ['', 'index.html'],
        ['index.html', 'index.html'],
        ['app.js', 'app.js'],
    ])
    addDevServerHandler({
        route: DEVTOOLS_PATH,
        handler: eventHandler(async (event) => {
            const name = assets.get(event.path.split('?')[0]!.replace(DEVTOOLS_PATH, '').replace(/^\//u, ''))
            if (!name) return
            setHeader(event, 'Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8')
            setHeader(event, 'Cache-Control', 'no-store')
            return readFile(new URL(`./client/${name}`, import.meta.url), 'utf8')
        }),
    })
    nuxt.hook('devtools:customTabs', (tabs) =>
        tabs.push({
            name: 'site-admin',
            title: 'Site Admin',
            icon: 'ph:database',
            view: { type: 'iframe', src: DEVTOOLS_PATH },
        }),
    )
}
