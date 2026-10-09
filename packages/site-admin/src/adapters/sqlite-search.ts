/** Derived search text is separate from canonical typed columns and cannot reconstruct a revision. */
export const searchPrefix = 'content_search:v1:'
export const searchKey = (id: string, scope: string, kind: 'data' | 'slug') => {
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
        source,
        locale: new Intl.Collator().resolvedOptions().locale,
        // Unicode 16/17 introduced these case pairs. Different engines must not reuse their text.
        casing: '\u1c89\ua7cb\ua7cc\ua7ce\ua7d2\ua7d4\ua7da\ua7dc\u{16ea0}'.toLocaleLowerCase(),
    })
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
