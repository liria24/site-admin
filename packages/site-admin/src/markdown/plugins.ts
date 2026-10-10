import type { ParserOptions, Node } from 'comark'
import summary from 'comark/plugins/summary'
import type { SiteAdminConfig } from '../config'
import { markdownAssets, type AssetUrlResolver } from './assets'
import { paragraphSummary } from './summary'

export const markdownPlugins = (
    options: SiteAdminConfig['markdown'],
    resolve: AssetUrlResolver,
): NonNullable<ParserOptions['plugins']> => {
    const assets = markdownAssets(resolve)
    const configured = options?.plugins ?? []
    const plugins: Array<NonNullable<ParserOptions['plugins']>[number]> = [assets, ...configured]
    if (options?.summary?.enabled !== false) {
        plugins.push(summary({ delimiter: options?.summary?.delimiter ?? '<!-- more -->' }))
        plugins.push({
            name: 'site-admin-summary-fallback',
            post(state) {
                if (state.tree.meta.summary !== undefined) return
                const fallback = paragraphSummary(state.tree.nodes)
                if (fallback) state.tree.meta.summary = fallback
            },
        })
    }
    // Comark's summary plugin rebuilds nodes from tokens, independently of tree.nodes.
    // Resolve before applying the same configured URL safety policy to that separate tree.
    // Like Comark, use the first plugin of each name. Never re-run arbitrary user plugins.
    const security = configured.find((plugin) => plugin.name === 'security')
    plugins.push({
        name: 'site-admin-summary-assets',
        async post(state) {
            if (!Array.isArray(state.tree.meta.summary)) return
            // Consumer summary overrides may share descendants with the body AST.
            const tree = { ...state.tree, nodes: structuredClone(state.tree.meta.summary as Node[]) }
            const summaryState = { ...state, tree }
            await assets.post?.(summaryState)
            await security?.post?.(summaryState)
            state.tree.meta.summary = summaryState.tree.nodes
        },
    })
    return plugins
}
