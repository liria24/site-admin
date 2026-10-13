import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Explicit verification-only compatibility patch; never imported by the published Site Admin package. */
export const nuxt46Compatibility = {
    version: '4.6.1',
    originalSha: '589f3b909987286ef4aebc83ae76a669d0fd4eebfea60ba8995bd842cde566d8',
    patchedSha: 'ff278c0ca32548e71f25ef970cc405035452788d777d378ae97784b886ad8319',
    patchSha: '47c93c9b2653db4557dbf5b3a2f9ae2b808f56ed2cdb6c72db0f3f80d07ffef2',
} as const

export const nuxt46Checksum = (source: string): string => createHash('sha256').update(source).digest('hex')

/** The reviewed single-file, two-hunk patch also gives tests the exact unchanged original negative control. */
export const nuxt46SourceVariants = async (source: string): Promise<{ original: string; patched: string }> => {
    const checksum = nuxt46Checksum(source)
    const reverse = checksum === nuxt46Compatibility.patchedSha
    if (!reverse && checksum !== nuxt46Compatibility.originalSha)
        throw new Error('Unknown Nuxt 4.6.1 asyncData source.')
    const patch = await readFile(new URL('../patches/nuxt@4.6.1.patch', import.meta.url), 'utf8')
    if (nuxt46Checksum(patch) !== nuxt46Compatibility.patchSha)
        throw new Error('Nuxt compatibility patch checksum changed.')
    const hunks = patch.split(/^@@.*\n/gmu).slice(1)
    if (
        !patch.startsWith('diff --git a/dist/app/composables/asyncData.js b/dist/app/composables/asyncData.js\n') ||
        hunks.length !== 2
    )
        throw new Error('Unexpected Nuxt compatibility patch target.')
    let changed = source
    for (const hunk of hunks) {
        const lines = hunk.split('\n')
        const original = lines
            .filter((line) => line.startsWith(' ') || line.startsWith('-'))
            .map((line) => line.slice(1))
            .join('\n')
        const patched = lines
            .filter((line) => line.startsWith(' ') || line.startsWith('+'))
            .map((line) => line.slice(1))
            .join('\n')
        const before = reverse ? patched : original
        if (changed.split(before).length !== 2) throw new Error('Nuxt compatibility hunk did not match exactly once.')
        changed = changed.replace(before, reverse ? original : patched)
    }
    const variants = reverse ? { original: changed, patched: source } : { original: source, patched: changed }
    if (
        nuxt46Checksum(variants.original) !== nuxt46Compatibility.originalSha ||
        nuxt46Checksum(variants.patched) !== nuxt46Compatibility.patchedSha
    )
        throw new Error('Nuxt compatibility patch result checksum mismatch.')
    return variants
}

/** Explicit fixture setup after package installation, before prepare/build; package and byte guards are mandatory. */
export const applyNuxt46VerificationPatch = async (directory: string): Promise<void> => {
    const require = createRequire(join(directory, 'package.json'))
    const manifest = require.resolve('nuxt/package.json')
    const meta = JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown }
    if (meta.version !== nuxt46Compatibility.version)
        throw new Error('Nuxt compatibility patch requires exactly Nuxt 4.6.1.')
    const target = join(dirname(manifest), 'dist/app/composables/asyncData.js')
    const source = await readFile(target, 'utf8')
    const { patched } = await nuxt46SourceVariants(source)
    if (source !== patched) await writeFile(target, patched)
}
