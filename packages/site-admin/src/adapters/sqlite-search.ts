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
    let length = 0
    for (const codePoint of q) {
        void codePoint
        length++
    }
    return {
        sql: `(instr(${root}.value,?)>0 OR EXISTS (
            SELECT 1 FROM site_admin_meta c JOIN site_admin_meta p ON p.key=CASE WHEN CAST(substr(c.key,length(${root}.key)+2) AS INTEGER)=1 THEN ${root}.key ELSE ${root}.key||':'||printf('%06d',CAST(substr(c.key,length(${root}.key)+2) AS INTEGER)-1) END
            WHERE c.key>=${root}.key||':000001' AND c.key<${root}.key||':~' AND instr(substr(p.value,max(1,length(p.value)-${length}+2))||c.value,?)>0))`,
        params: [q, q],
    }
}
