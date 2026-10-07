import { defineConfig } from 'taze'

export default defineConfig({
    force: true,
    write: true,
    install: false,
    interactive: true,
    recursive: true,
    includeLocked: true,
    ignorePaths: ['**/node_modules/**'],
    ignoreOtherWorkspaces: true,
    // The internal Nitro 2 session/stream and development-server adapters require h3 v1.
    // Upgrade these together with the target Vite+ migrator.
    exclude: ['h3@>=2', 'vite', 'vite-plus', 'vitest'],
    depFields: {
        overrides: false,
        'bun-workspace': true,
    },
})
