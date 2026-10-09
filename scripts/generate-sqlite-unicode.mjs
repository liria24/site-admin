import { writeFileSync } from 'node:fs'

// Compact property ranges keep the portable SQLite/D1 predicate independent of ICU/UDFs.
const ranges = (matches) => {
    const output = []
    let start, previous
    for (let point = 0; point <= 0x10ffff; point++) {
        if (!matches(String.fromCodePoint(point))) continue
        if (previous !== undefined && point === previous + 1) previous = point
        else {
            if (previous !== undefined) output.push([start, previous])
            start = previous = point
        }
    }
    if (previous !== undefined) output.push([start, previous])
    return output
        .map(([first, last]) => (first === last ? first.toString(16) : first.toString(16) + ':' + last.toString(16)))
        .join(',')
}
const properties = {
    lowercaseSources: ranges((value) => value.toLowerCase() !== value),
    casedCharacters: ranges((value) => /\p{Cased}/u.test(value)),
    caseIgnorableCharacters: ranges((value) => /\p{Case_Ignorable}/u.test(value)),
}
writeFileSync(
    new URL('../packages/site-admin/src/adapters/sqlite-unicode-data.ts', import.meta.url),
    `// Generated from Node Unicode ${process.versions.unicode} by scripts/generate-sqlite-unicode.mjs.\n` +
        Object.entries(properties)
            .map(([name, value]) => `export const ${name} = '${value}'\n`)
            .join(''),
)
