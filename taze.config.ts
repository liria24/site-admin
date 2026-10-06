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
    // Nitro 2 and our public H3Event hooks require h3 v1.
    exclude: ['h3@>=2'],
    depFields: {
        overrides: false,
        'bun-workspace': true,
    },
})
