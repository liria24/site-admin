import assert from 'node:assert/strict'

/** Reject executable/static Node drivers, not the SDK's dormant variable-import fallback. */
export const assertNoNodeSQLiteDriver = (source) => {
    const staticImport = /\b(?:import\s*(?:[^;]*?\bfrom\s*)?|export\s+[^;]*?\bfrom\s*)['"]node:sqlite['"]/u
    const literalLoad = /\b(?:import|require)\s*\(\s*['"]node:sqlite['"]/u
    const nativeDrizzleClass = /\bclass\s+NodeSQLiteDatabase\b|\bstatic\s*\[[^\]]+\]\s*=\s*['"]NodeSQLiteDatabase['"]/u
    if (
        staticImport.test(source) ||
        literalLoad.test(source) ||
        /drizzle-orm\/node-sqlite/u.test(source) ||
        nativeDrizzleClass.test(source)
    )
        throw new Error('The D1 worker bundled a Node SQLite driver import or native Drizzle driver.')
}

export const verifyNodeSQLiteDriverCheck = () => {
    for (const source of [
        'import "node:sqlite"',
        'import { DatabaseSync } from "node:sqlite"',
        'export { DatabaseSync } from "node:sqlite"',
        'await import("node:sqlite")',
        'const sqlite = require("node:sqlite")',
        'import { drizzle } from "drizzle-orm/node-sqlite"',
        'class NodeSQLiteDatabase {}',
        'const Database = class extends Base { static [kind] = "NodeSQLiteDatabase" }',
    ])
        assert.throws(() => assertNoNodeSQLiteDriver(source), /Node SQLite driver/u)
    assert.doesNotThrow(() => assertNoNodeSQLiteDriver('import { drizzle } from "drizzle-orm/d1"'))
    assert.doesNotThrow(() => assertNoNodeSQLiteDriver('const supported = ["NodeSQLiteDatabase", "D1Database"]'))
    assert.doesNotThrow(() =>
        assertNoNodeSQLiteDriver('const fallback = "node:sqlite"; if (native) await import(fallback)'),
    )
}
