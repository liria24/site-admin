import { defineFilesConfig } from 'nuxt-files-sdk/config'

export default defineFilesConfig({
    storage: {
        content: { adapter: 'memory' },
    },
    $development: {
        storage: {
            content: { adapter: 'fs', config: { root: '.data/files/content' } },
        },
    },
})
