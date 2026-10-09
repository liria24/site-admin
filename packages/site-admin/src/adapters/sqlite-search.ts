import { lowercaseSources, casedCharacters, caseIgnorableCharacters } from './sqlite-unicode-data'

const ranges = (value: string): Array<[number, number]> =>
    value.split(',').map((part) => {
        const [first, last = first] = part.split(':')
        return [Number.parseInt(first!, 16), Number.parseInt(last!, 16)]
    })
const propertyGlob = (value: string): string =>
    '[' +
    ranges(value)
        .map(([first, last]) => String.fromCodePoint(first) + (first === last ? '' : '-' + String.fromCodePoint(last)))
        .join('') +
    ']'
let lowercaseRules: Array<[string, string]> | undefined
const rules = () =>
    (lowercaseRules ??= ranges(lowercaseSources).flatMap(([first, last]) =>
        Array.from({ length: last - first + 1 }, (_, offset): [string, string] => {
            const source = String.fromCodePoint(first + offset)
            return [source, source.toLocaleLowerCase()]
        }),
    ))

/** SQL performs Unicode substring filtering before count/page; no source rows leave the DB for filtering. */
export const sqliteSearch = (column: string, query: string): { sql: string; params: string[] } => {
    const normalized = query.toLocaleLowerCase()
    const characters = new Set(normalized)
    const selected = rules().filter(
        ([source, target]) => source !== 'Σ' && Array.from(target).some((char) => characters.has(char)),
    )
    const sigma = characters.has('σ') || characters.has('ς')
    if (!selected.length && !sigma) return { sql: `instr(${column},?)>0`, params: [normalized] }
    const spec = JSON.stringify({
        rules: selected,
        ...(sigma
            ? {
                  cased: propertyGlob(casedCharacters),
                  ignored: propertyGlob(caseIgnorableCharacters),
              }
            : {}),
    })
    // Greek Final_Sigma depends on the nearest non-case-ignorable characters on both sides.
    const initial = sigma
        ? `
      characters(pos,ch) AS (SELECT 1,substr((SELECT text FROM source),1,1) UNION ALL SELECT pos+1,substr((SELECT text FROM source),pos+1,1) FROM characters WHERE pos<length((SELECT text FROM source))),
      context(pos,ch,cased,ignored) AS MATERIALIZED (SELECT pos,ch,ch GLOB json_extract((SELECT data FROM spec),'$.cased'),ch GLOB json_extract((SELECT data FROM spec),'$.ignored') FROM characters),
      initial(text) AS (SELECT group_concat(ch,'') FROM (SELECT CASE WHEN ctx.ch='Σ' THEN CASE WHEN (SELECT cased FROM context WHERE pos<ctx.pos AND ignored=0 ORDER BY pos DESC LIMIT 1)=1 AND COALESCE((SELECT cased FROM context WHERE pos>ctx.pos AND ignored=0 ORDER BY pos LIMIT 1),0)=0 THEN 'ς' ELSE 'σ' END ELSE ctx.ch END AS ch FROM context ctx ORDER BY pos)),`
        : 'initial(text) AS (SELECT text FROM source),'
    return {
        sql: `instr((WITH RECURSIVE spec(data) AS (VALUES(?)),source(text) AS (SELECT ${column}),${initial}
          rules(step,before,after) AS (SELECT CAST(key AS INTEGER),json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each((SELECT data FROM spec),'$.rules')),
          folded(step,text) AS (SELECT 0,text FROM initial UNION ALL SELECT folded.step+1,replace(text,before,after) FROM folded JOIN rules ON rules.step=folded.step)
          SELECT text FROM folded ORDER BY step DESC LIMIT 1),?)>0`,
        params: [spec, normalized],
    }
}
