/** Derived search text is separate from canonical typed columns and cannot reconstruct a revision. */
export const searchPrefix = 'content_search:v1:'
export const searchKey = (id: string, scope: string, kind: string) => {
    const encoded = Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    return `${searchPrefix}${encoded}:${scope}:${kind}`
}
export const searchText = (data: Record<string, unknown>, slug: string) => ({
    data: JSON.stringify(data).toLocaleLowerCase(),
    slug: slug.toLocaleLowerCase(),
})

/** Separate physical projections and locale/engine case mappings without table changes or per-process keys. */
export const searchScope = async (source: string): Promise<string> => {
    const input = JSON.stringify({
        format: 'bounded-chunks-v1',
        source,
        locale: new Intl.Collator().resolvedOptions().locale,
        // Unicode 16/17 introduced these case pairs. Different engines must not reuse their text.
        casing: '\u1c89\ua7cb\ua7cc\ua7ce\ua7d2\ua7d4\ua7da\ua7dc\u{16ea0}'.toLocaleLowerCase(),
    })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
const chunkCharacters = 131_072
const partKey = (kind: 'data' | 'slug', index: number) => (index ? `${kind}:${String(index).padStart(6, '0')}` : kind)
export const searchParts = (text: { data: string; slug: string }) =>
    Object.entries(text).flatMap(([kind, value]) => {
        const field = kind as 'data' | 'slug'
        if (new TextEncoder().encode(value).byteLength <= 1_048_576) return [{ part: field, value }]
        const points = Array.from(value)
        const parts: Array<{ part: string; value: string }> = []
        for (let offset = 0; offset < points.length; offset += chunkCharacters)
            parts.push({
                part: partKey(field, offset / chunkCharacters),
                value: points.slice(offset, offset + chunkCharacters).join(''),
            })
        return parts
    })

export const searchPredicate = (root: 'search_data' | 'search_slug', q: string) => {
    const points = Array.from(q)
    const length = points.length
    if (length <= chunkCharacters)
        return {
            sql: `(instr(${root}.value,?)>0 OR EXISTS (
            SELECT 1 FROM site_admin_meta c JOIN site_admin_meta p ON p.key=CASE WHEN CAST(substr(c.key,length(${root}.key)+2) AS INTEGER)=1 THEN ${root}.key ELSE ${root}.key||':'||printf('%06d',CAST(substr(c.key,length(${root}.key)+2) AS INTEGER)-1) END
            WHERE c.key>=${root}.key||':000001' AND c.key<${root}.key||':~' AND instr(substr(p.value,max(1,length(p.value)-${length}+2))||c.value,?)>0))`,
            params: [q, q],
        }
    // Prefix candidates and comparisons stay in native SQL without concatenating the full large text.
    const frequencies = new Map<string, number>()
    for (const point of points) frequencies.set(point, (frequencies.get(point) ?? 0) + 1)
    let rarest = 0
    for (let index = 1; index < length; index++)
        if (frequencies.get(points[index]!)! < frequencies.get(points[rarest]!)!) rarest = index
    const anchorOffset = Math.max(0, Math.min(rarest - 31, length - 64))
    const anchor = points.slice(anchorOffset, anchorOffset + 64).join('')
    const start = `(a.n*${chunkCharacters}+a.at-1-${anchorOffset})`
    const local = `max(0,${start}-p.n*${chunkCharacters})`
    const offset = `max(0,p.n*${chunkCharacters}-${start})`
    const take = `min(length(p.value)-${local},length(needle.q)-${offset})`
    return {
        sql: `EXISTS (WITH RECURSIVE needle(q,anchor) AS (VALUES (?,?)),
            parts(n,value) AS (
                SELECT 0,${root}.value UNION ALL SELECT CAST(substr(m.key,length(${root}.key)+2) AS INTEGER),m.value FROM site_admin_meta m WHERE m.key>=${root}.key||':000001' AND m.key<${root}.key||':~'
            ), windows(n,span,value) AS (
                SELECT p.n,length(p.value),p.value||COALESCE(next.value,'') FROM parts p LEFT JOIN parts next ON next.n=p.n+1
            ), candidates(n,span,value,at) AS (
                SELECT n,span,value,instr(value,anchor) FROM windows,needle
                UNION ALL SELECT n,span,value,at+instr(substr(value,at+1),anchor) FROM candidates,needle WHERE at>0 AND at<span AND instr(substr(value,at+1),anchor)>0
            )
            SELECT 1 FROM needle WHERE (CASE WHEN length(${root}.value)>=length(q) THEN instr(${root}.value,q) ELSE 0 END)>0 OR (EXISTS (SELECT 1 FROM parts WHERE n>0) AND EXISTS (
                SELECT 1 FROM candidates a WHERE a.at>0 AND a.at<=a.span
                AND ${start}>=0
                AND ${start}+length(needle.q)<=(SELECT max(n*${chunkCharacters}+length(value)) FROM parts)
                AND NOT EXISTS (SELECT 1 FROM parts p WHERE p.n*${chunkCharacters}<${start}+length(needle.q) AND p.n*${chunkCharacters}+length(p.value)>${start}
                    AND substr(p.value,${local}+1,${take})<>substr(needle.q,${offset}+1,${take}))
            )))`,
        params: [q, anchor],
    }
}
