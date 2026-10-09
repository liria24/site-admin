import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('generates content schema without loading optional ORM or auth adapter peers', () => {
    const output = execFileSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
import { registerHooks } from 'node:module'
import { createJiti } from 'jiti'
import assert from 'node:assert/strict'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.includes('drizzle-orm') || /@better-auth[+/]drizzle-adapter/u.test(specifier))
            throw new Error('Optional ORM peer was loaded: ' + specifier)
        return nextResolve(specifier, context)
    },
})
await assert.rejects(import('drizzle-orm'), /Optional ORM peer was loaded/u)
const { generateSiteAdminSchema } = await createJiti(import.meta.url, { fsCache: false, moduleCache: false })
    .import(process.argv[1])
const schema = generateSiteAdminSchema({ models: { posts: { fields: { title: { kind: 'text', required: true } } } } })
assert.match(schema, /site_admin_content_posts/u)
assert.match(schema, /text\\("field_title"\\)\\.notNull\\(\\)/u)
assert.throws(() => generateSiteAdminSchema({ models: { posts: { fields: { revisionId: { kind: 'text' } } } } }), /reserved field/u)
console.log('Content schema generated without optional ORM peers.')
`,
            resolve('packages/site-admin/src/generate.ts'),
        ],
        { encoding: 'utf8' },
    )
    expect(output).toContain('Content schema generated without optional ORM peers.')
})
