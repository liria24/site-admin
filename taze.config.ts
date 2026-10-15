import { defineConfig } from 'taze'

export default defineConfig({
    force: true,
    write: true,
    install: false,
    interactive: true,
    recursive: true,
    includeLocked: true,
    ignorePaths: ['**/node_modules/**', '**/.tmp/**', '**/.data/**'],
    ignoreOtherWorkspaces: true,
    exclude: ['h3@>=2', 'vite', 'vite-plus'],
    depFields: {
        overrides: false,
        'bun-workspace': true,
    },
})
