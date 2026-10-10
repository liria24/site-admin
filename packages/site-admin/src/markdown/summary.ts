import type { ElementNode, Node } from 'comark'
import { astText, cleanText } from './document'

/** Bounded fallback over native AST. Never changes the body or reparses Markdown. */
export const paragraphSummary = (nodes: readonly Node[]): Node[] | undefined => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const inline = new Set(['a', 'em', 'strong', 's', 'del', 'br'])
    let remaining = 280
    const text = (value: string): string => {
        let result = ''
        for (const { segment } of segmenter.segment(value)) {
            if (!remaining) break
            remaining--
            result += segment
        }
        return result
    }
    const copy = (node: Node, depth: number): Node[] => {
        if (!remaining || depth > 32) return []
        if (typeof node === 'string') return [text(node)]
        if (node[0] === null || node[1].$?.html || !inline.has(node[0])) return []
        const children = (node.slice(2) as Node[]).flatMap((child) => copy(child, depth + 1))
        if (!children.length && node[0] !== 'br') return []
        return [[node[0], structuredClone(node[1]), ...children]]
    }
    const result: ElementNode[] = []
    for (const node of nodes) {
        if (!remaining || result.length === 2) break
        if (typeof node === 'string' || node[0] !== 'p' || node[1].$?.html) continue
        const before = remaining
        const children = (node.slice(2) as Node[]).flatMap((child) => copy(child, 0))
        if (cleanText(astText(children))) result.push(['p', structuredClone(node[1]), ...children])
        else remaining = before
    }
    return result.length ? result : undefined
}
