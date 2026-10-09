import { describe, expect, it } from 'vitest'
import { allowGeneratedFilesConfig } from '../packages/site-admin/src/nuxt/files-source'

describe('native Files generated TypeScript configuration', () => {
    it('exempts only the generated directory while retaining native dependency exclusions', () => {
        const directory = '/app/node_modules/.cache/nuxt/.nuxt/nuxt-files-sdk'
        const original = /node_modules/u
        const [exclude] = allowGeneratedFilesConfig([original], directory)
        expect(exclude).toBeInstanceOf(RegExp)
        const pattern = exclude as RegExp
        expect(pattern.test(`${directory}/selected.ts`)).toBe(false)
        expect(pattern.test(`${directory}/nested/generated.ts`)).toBe(false)
        expect(pattern.test(`${directory}-other/selected.ts`)).toBe(true)
        expect(pattern.test('/app/node_modules/library/source.ts')).toBe(true)
        expect(pattern.test('/app/node_modules/.cache/nuxt/.nuxt/other/generated.ts')).toBe(true)
        expect(original.source).toBe('node_modules')
    })

    it('handles Windows separators and preserves explicit string exclusions', () => {
        const directory = 'C:\\app\\node_modules\\.cache\\nuxt\\.nuxt\\nuxt-files-sdk'
        const patterns = allowGeneratedFilesConfig([/[\\/]node_modules[\\/]/iu, '**/ignored.ts'], directory)
        const pattern = patterns[0] as RegExp
        expect(pattern.flags).toBe('iu')
        expect(pattern.test(`${directory}\\selected.ts`)).toBe(false)
        expect(pattern.test('C:/app/node_modules/.cache/nuxt/.nuxt/nuxt-files-sdk/selected.ts')).toBe(false)
        expect(pattern.test('C:\\app\\node_modules\\library\\source.ts')).toBe(true)
        expect(patterns[1]).toBe('**/ignored.ts')
    })
})
