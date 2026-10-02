import type { ComarkPlugin, ElementNode, Node } from 'comark'
import security from 'comark/plugins/security'

export interface MarkdownAssetReference {
    id: string
    position: number
}

export type AssetUrlResolver = (id: string) => string

const assetPattern = () => /site-admin:\/\/asset\/([A-Za-z0-9_-]+)/gu

// Retained revisions use these source-order positions in their reference ledger.
// Keep code examples, unused definitions and repeated references until a ledger migration is designed.
export const markdownAssetReferences = (source: string): MarkdownAssetReference[] =>
    Array.from(source.matchAll(assetPattern()), (match, position) => ({
        id: match[1]!,
        position,
    }))

// Compatibility adapter for the public entry API's Markdown *string* contract.
// content() uses the original source and the AST plugin below instead.
export const resolveMarkdownSource = (source: string, resolve: AssetUrlResolver): string =>
    source.replace(assetPattern(), (_, id: string) => resolve(id))

interface Destination {
    node: ElementNode
    name: string
    check: ElementNode
}

const resolveNodes = (
    nodes: Node[],
    tracked: Set<string>,
    resolve: AssetUrlResolver,
    destinations: Destination[],
): void => {
    for (const node of nodes) {
        if (typeof node === 'string' || node[0] === null || node[0] === 'code' || node[0] === 'pre') continue
        for (const name of ['src', 'href', 'xlink:href']) {
            const value = node[1][name]
            if (typeof value !== 'string' || !value.startsWith('site-admin://asset/')) continue
            const id = /^site-admin:\/\/asset\/([A-Za-z0-9_-]+)$/u.exec(value)?.[1]
            // Never create a destination for a reference absent from the revision ledger grammar.
            if (!id || !tracked.has(id)) delete node[1][name]
            else {
                // Validate only generated destinations, without changing the rest of the user's tree.
                destinations.push({ node, name, check: ['span', { [name]: resolve(id) }] })
            }
        }
        resolveNodes(node.slice(2) as Node[], tracked, resolve, destinations)
    }
}

/** Stateless, synchronous URL resolution; all readiness/visibility checks belong to SiteAdmin. */
export const markdownAssets = (resolve: AssetUrlResolver): ComarkPlugin => ({
    name: 'site-admin-assets',
    pre(state) {
        // Capture before consumer pre hooks can introduce destinations absent from stored source.
        state.siteAdminAssetReferences = markdownAssetReferences(state.markdown)
    },
    async post(state) {
        const destinations: Destination[] = []
        const references: MarkdownAssetReference[] = state.siteAdminAssetReferences ?? []
        resolveNodes(state.tree.nodes, new Set(references.map(({ id }) => id)), resolve, destinations)
        await security().post?.({ ...state, tree: { ...state.tree, nodes: destinations.map(({ check }) => check) } })
        for (const { node, name, check } of destinations) {
            if (Object.hasOwn(check[1], name)) node[1][name] = check[1][name]
            else delete node[1][name]
        }
    },
})
