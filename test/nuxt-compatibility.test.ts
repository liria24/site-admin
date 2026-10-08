import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vite-plus/test'

import {
    applyNuxt46VerificationPatch,
    nuxt46Checksum,
    nuxt46Compatibility,
    nuxt46SourceVariants,
} from './nuxt-compatibility'

let variants: { original: string; patched: string }

beforeAll(async () => {
    const require = createRequire(new URL('../package.json', import.meta.url))
    const manifest = require.resolve('nuxt/package.json')
    const source = await readFile(join(dirname(manifest), 'dist/app/composables/asyncData.js'), 'utf8')
    variants = await nuxt46SourceVariants(source)
})

const withPackage = async (
    source: string,
    verify: (fixture: { directory: string; target: string; unrelated: string; manifest: string }) => Promise<void>,
    version = nuxt46Compatibility.version as string,
): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'site-admin-nuxt-compatibility-'))
    const packageDirectory = join(directory, 'node_modules/nuxt')
    const composables = join(packageDirectory, 'dist/app/composables')
    const target = join(composables, 'asyncData.js')
    const unrelated = join(composables, 'unrelated.js')
    const manifest = join(packageDirectory, 'package.json')
    try {
        await mkdir(composables, { recursive: true })
        await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true }))
        await writeFile(
            manifest,
            JSON.stringify({ name: 'nuxt', version, exports: { './package.json': './package.json' } }),
        )
        await writeFile(target, source)
        await writeFile(unrelated, variants.original)
        await verify({ directory, target, unrelated, manifest })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

describe('verification-only Nuxt 4.6 compatibility patch', () => {
    it('derives the exact guarded patched bytes from the unchanged original source', async () => {
        const result = await nuxt46SourceVariants(variants.original)
        expect(nuxt46Checksum(result.original)).toBe(nuxt46Compatibility.originalSha)
        expect(nuxt46Checksum(result.patched)).toBe(nuxt46Compatibility.patchedSha)
        expect(Buffer.from(result.original)).toEqual(Buffer.from(variants.original))
        expect(Buffer.from(result.patched)).toEqual(Buffer.from(variants.patched))
        expect(result.original).not.toBe(result.patched)
    })

    it('recovers the exact original negative control without changing its file', async () => {
        await withPackage(variants.original, async ({ target }) => {
            const original = await readFile(target)
            const result = await nuxt46SourceVariants(variants.patched)
            expect(nuxt46Checksum(result.original)).toBe(nuxt46Compatibility.originalSha)
            expect(Buffer.from(result.original)).toEqual(original)
            expect(Buffer.from(result.patched)).toEqual(Buffer.from(variants.patched))
            expect(await readFile(target)).toEqual(original)
        })
    })

    it('applies only the reviewed native file and retains unrelated package bytes', async () => {
        await withPackage(variants.original, async ({ directory, target, unrelated, manifest }) => {
            const unrelatedBefore = await readFile(unrelated)
            const manifestBefore = await readFile(manifest)
            await applyNuxt46VerificationPatch(directory)
            expect(await readFile(target)).toEqual(Buffer.from(variants.patched))
            expect(await readFile(unrelated)).toEqual(unrelatedBefore)
            expect(await readFile(manifest)).toEqual(manifestBefore)
        })
    })

    it('is idempotent and does not rewrite an already patched file', async () => {
        await withPackage(variants.original, async ({ directory, target }) => {
            await applyNuxt46VerificationPatch(directory)
            const timestamp = new Date('2000-01-01T00:00:00Z')
            await utimes(target, timestamp, timestamp)
            const before = await stat(target, { bigint: true })
            await applyNuxt46VerificationPatch(directory)
            await applyNuxt46VerificationPatch(directory)
            expect(await readFile(target)).toEqual(Buffer.from(variants.patched))
            expect((await stat(target, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
        })
    })

    it('rejects unknown source bytes before changing any package file', async () => {
        const unknown = variants.original + '\n// unreviewed native source\n'
        await withPackage(unknown, async ({ directory, target, unrelated, manifest }) => {
            const manifestBefore = await readFile(manifest)
            await expect(applyNuxt46VerificationPatch(directory)).rejects.toThrow(
                'Unknown Nuxt 4.6.0 asyncData source.',
            )
            expect(await readFile(target)).toEqual(Buffer.from(unknown))
            expect(await readFile(unrelated)).toEqual(Buffer.from(variants.original))
            expect(await readFile(manifest)).toEqual(manifestBefore)
        })
    })

    it.each(['4.6.1', '4.6.0-rc.1'])('rejects Nuxt %s before changing package bytes', async (version) => {
        await withPackage(
            variants.original,
            async ({ directory, target, unrelated, manifest }) => {
                const manifestBefore = await readFile(manifest)
                await expect(applyNuxt46VerificationPatch(directory)).rejects.toThrow(
                    'Nuxt compatibility patch requires exactly Nuxt 4.6.0.',
                )
                expect(await readFile(target)).toEqual(Buffer.from(variants.original))
                expect(await readFile(unrelated)).toEqual(Buffer.from(variants.original))
                expect(await readFile(manifest)).toEqual(manifestBefore)
            },
            version,
        )
    })
})
