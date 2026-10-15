import { expect, it } from 'vitest'
import manifest from '../packages/site-admin/package.json'

it('declares shared runtime packages as peers without exporting dependency aliases', () => {
    expect(manifest.exports).not.toHaveProperty('./dependency-aliases')
    for (const name of [
        'better-auth',
        '@nuxtjs/better-auth',
        'ai',
        'comark',
        'files-sdk',
        'nuxt-files-sdk',
        '@tanstack/vue-form',
        'nuxt',
        'vue',
    ]) {
        expect(manifest.peerDependencies).toHaveProperty(name)
        expect(manifest.dependencies).not.toHaveProperty(name)
    }
    expect(manifest.dependencies).toHaveProperty('comark-content')
})
