import { describe, expect, it, vi } from 'vitest'
import { parseMarkdown } from 'comark'
import security from 'comark/plugins/security'
import type { Node, ElementNode } from 'comark'
import {
    markdownAssetReferences,
    markdownAssets,
    resolveMarkdownSource,
} from '../packages/site-admin/src/markdown/assets'
import { markdownPlugins } from '../packages/site-admin/src/markdown/plugins'
import { createMarkdownContent } from '../packages/site-admin/src/markdown/content'
import { astText, cleanText } from '../packages/site-admin/src/markdown/document'
import { array, markdown, object } from '../packages/site-admin/src/fields'
import { collectReferences } from '../packages/site-admin/src/validation'

const url = (id: string) => `/custom/content/_assets/${id}`
const elements = (nodes: Node[], tag: string): ElementNode[] =>
    nodes.flatMap((node): ElementNode[] =>
        typeof node === 'string' || node[0] === null
            ? []
            : [...(node[0] === tag ? [node] : []), ...elements(node.slice(2) as Node[], tag)],
    )

describe('internal Markdown asset contracts', () => {
    it('keeps legacy source-order ledger metadata and string projection without reformatting', () => {
        const source =
            '  ![a](site-admin://asset/a)\r\n\r\n`site-admin://asset/code`\r\n' +
            '```txt\nsite-admin://asset/fence\n```\n' +
            '[unused]: site-admin://asset/unused\n' +
            ':card{label="site-admin://asset/label" :src="site-admin://asset/bound"}\n' +
            'plain site-admin://asset/a site-admin://asset/prefix.suffix site-admin://asset/ 日本語'
        const ids = ['a', 'code', 'fence', 'unused', 'label', 'bound', 'a', 'prefix']
        expect(markdownAssetReferences(source)).toEqual(ids.map((id, position) => ({ id, position })))
        expect(
            collectReferences({ sections: array(object({ body: markdown() })) }, { sections: [{ body: source }] })
                .assets,
        ).toEqual(ids.map((id, position) => ({ id, position, path: 'sections.0.body.$markdown' })))
        const projected = source.replace(/site-admin:\/\/asset\/([A-Za-z0-9_-]+)/gu, (_, id: string) => url(id))
        expect(resolveMarkdownSource(source, url)).toBe(projected)
        expect(resolveMarkdownSource(projected, url)).toBe(projected)
        expect(resolveMarkdownSource('plain\r\n', url)).toBe('plain\r\n')
        expect(JSON.parse(JSON.stringify(markdownAssetReferences(source)))).toEqual(markdownAssetReferences(source))
    })

    it('resolves actual destinations in nested Markdown, references and static component props', async () => {
        const source =
            '![a](site-admin://asset/a)\n\n[download][ref]\n\n[ref]: site-admin://asset/a\n\n' +
            '> - ![nested](site-admin://asset/a)\n\n' +
            '::card{src="site-admin://asset/a" href="site-admin://asset/a" label="site-admin://asset/a" :src="data.url"}\n' +
            '![inside](site-admin://asset/a)\n::\n\n' +
            '<Photo src="site-admin://asset/a" xlink:href="site-admin://asset/a" />'
        const document = await parseMarkdown(source, { plugins: [markdownAssets(url)] })
        expect(elements(document.nodes, 'img').map((node) => node[1].src)).toEqual([url('a'), url('a'), url('a')])
        expect(elements(document.nodes, 'a')[0]?.[1].href).toBe(url('a'))
        expect(elements(document.nodes, 'card')[0]?.[1]).toMatchObject({
            src: url('a'),
            href: url('a'),
            label: 'site-admin://asset/a',
            ':src': 'data.url',
        })
        expect(elements(document.nodes, 'photo')[0]?.[1]).toMatchObject({ src: url('a'), 'xlink:href': url('a') })
        expect(document.meta).toEqual({})
    })

    it('preserves code, prose, escaped syntax, frontmatter, arbitrary and bound props', async () => {
        const source =
            '---\nexample: site-admin://asset/a\n---\n' +
            '`site-admin://asset/a`\n\n```md\n![example](site-admin://asset/a)\n```\n\n' +
            'plain site-admin://asset/a\n\n\\![escaped]\\(site-admin://asset/a\\)\n\n' +
            ':card{label="site-admin://asset/a" :src="site-admin://asset/a" poster="site-admin://asset/a"}'
        const native = await parseMarkdown(source)
        const document = await parseMarkdown(source, { plugins: [markdownAssets(url)] })
        expect(document).toEqual(native)
    })

    it('does not resolve decoded or malformed destinations outside the tracked ID set', async () => {
        const source =
            '![entity](site-admin&colon;//asset/hidden)\n\n' +
            '![escaped](site-admin://asset/a\\_b)\n\n![suffix](site-admin://asset/a.png)\n\n' +
            '![query](site-admin://asset/a?x=1)\n\n![empty](site-admin://asset/)\n\n' +
            '[external](https://example.com/site-admin://asset/a)'
        const document = await parseMarkdown(source, { plugins: [markdownAssets(url)] })
        expect(elements(document.nodes, 'img').map((node) => node[1].src)).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
        ])
        expect(elements(document.nodes, 'a')[0]?.[1].href).toBe('https://example.com/site-admin://asset/a')
        expect(markdownAssetReferences(source).map(({ id }) => id)).toEqual(['a', 'a', 'a', 'a'])
    })

    it('is idempotent and isolates source metadata across concurrent parses', async () => {
        const resolve = vi.fn(url)
        const plugin = markdownAssets(resolve)
        const source = '![a](site-admin://asset/a)'
        const document = await parseMarkdown(source, { plugins: [plugin] })
        await plugin.post?.({ tree: document, markdown: source, options: {}, tokens: [] })
        expect(resolve).toHaveBeenCalledTimes(1)
        const [tracked, hidden] = await Promise.all([
            parseMarkdown(source, { plugins: [plugin] }),
            parseMarkdown('![a](site-admin&colon;//asset/a)', { plugins: [plugin] }),
        ])
        expect(elements(tracked.nodes, 'img')[0]?.[1].src).toBe(url('a'))
        expect(elements(hidden.nodes, 'img')[0]?.[1].src).toBeUndefined()
    })

    it('checks generated URLs before configured security and applies both to summary nodes', async () => {
        const source = '![a](site-admin://asset/a)\n\n<!-- more -->\n\nAfter'
        for (const target of ['javascript:alert(1)', 'https://blocked.example/a']) {
            const policy = security({ allowedImagePrefixes: ['https://allowed.example/'] })
            const document = await parseMarkdown(source, {
                plugins: markdownPlugins({ plugins: [policy] }, () => target),
            })
            expect(elements(document.nodes, 'img')[0]?.[1].src).toBeUndefined()
            expect(elements(document.meta.summary as Node[], 'img')[0]?.[1].src).toBeUndefined()
        }
        const safe = await parseMarkdown(source, {
            plugins: markdownPlugins(
                { plugins: [security({ allowedProtocols: ['https'] })] },
                () => 'https://allowed.example/a',
            ),
        })
        expect(elements(safe.nodes, 'img')[0]?.[1].src).toBe('https://allowed.example/a')
        expect(elements(safe.meta.summary as Node[], 'img')[0]?.[1].src).toBe('https://allowed.example/a')
        const unsafe = await parseMarkdown(source, { plugins: markdownPlugins(undefined, () => 'javascript:alert(1)') })
        expect(elements(unsafe.nodes, 'img')[0]?.[1].src).toBeUndefined()
        expect(elements(unsafe.meta.summary as Node[], 'img')[0]?.[1].src).toBeUndefined()
    })

    it('does not authorize new destinations introduced by consumer pre hooks', async () => {
        const document = await parseMarkdown('Original', {
            plugins: markdownPlugins(
                {
                    plugins: [
                        {
                            name: 'consumer',
                            pre(state) {
                                expect(state.markdown).toBe('Original')
                                state.markdown += '\n\n![injected](site-admin://asset/private)\n\n<!-- more -->'
                            },
                        },
                    ],
                },
                url,
            ),
        })
        expect(elements(document.nodes, 'img')[0]?.[1].src).toBeUndefined()
        expect(elements(document.meta.summary as Node[], 'img')[0]?.[1].src).toBeUndefined()
    })

    it('isolates summary safety transformations when a consumer shares body nodes', async () => {
        const document = await parseMarkdown('![a](/image)', {
            plugins: markdownPlugins(
                {
                    plugins: [
                        security({
                            allowedTags: ['p'],
                            tagFallback: (node) => ['em', {}, `Removed ${node[0]}`],
                        }),
                        {
                            name: 'summary',
                            post(state) {
                                state.tree.meta.summary = state.tree.nodes.slice()
                            },
                        },
                    ],
                },
                url,
            ),
        })
        expect(document.nodes).toEqual([['p', {}, ['em', {}, 'Removed img']]])
        expect(document.meta.summary).toEqual([['p', {}, ['em', {}, 'Removed em']]])
    })

    it('preserves async plugin order, summary overrides, delimiter and disable configuration', async () => {
        const events: string[] = []
        const configured = {
            name: 'consumer',
            async post(state: Parameters<NonNullable<ReturnType<typeof markdownAssets>['post']>>[0]) {
                await Promise.resolve()
                events.push(String(elements(state.tree.nodes, 'img')[0]?.[1].src))
                state.tree.meta.custom = 'kept'
            },
        }
        const source = 'Intro ![a](site-admin://asset/a)\n\n<!-- cut -->\n\nAfter'
        const document = await parseMarkdown(source, {
            plugins: markdownPlugins({ plugins: [configured], summary: { delimiter: '<!-- cut -->' } }, url),
        })
        expect(events).toEqual([url('a')])
        expect(document.meta.custom).toBe('kept')
        expect(cleanText(astText(document.meta.summary))).toBe('Intro')
        const disabled = await parseMarkdown(source, { plugins: markdownPlugins({ summary: { enabled: false } }, url) })
        expect(disabled.meta.summary).toBeUndefined()
        const override = await parseMarkdown(source, {
            plugins: markdownPlugins(
                {
                    plugins: [
                        {
                            name: 'summary',
                            post(state) {
                                state.tree.meta.summary = [['p', {}, 'Override']]
                            },
                        },
                    ],
                },
                url,
            ),
        })
        expect(override.meta.summary).toEqual([['p', {}, 'Override']])
    })

    it('preserves content source identity, nested fields, frontmatter and document output shape', async () => {
        const body = '---\ntitle: Frontmatter\n---\nIntro\n\n<!-- more -->\n\n![a](site-admin://asset/a)'
        const entry = {
            data: { body, sections: [{ body }] },
            id: 'entry',
            locale: '',
            model: 'posts',
            path: '/posts/post',
            publishedAt: '2026-01-01',
            revisionId: 'revision',
            slug: 'post',
        }
        const content = createMarkdownContent(
            'posts',
            { route: true, fields: { body: markdown(), sections: array(object({ body: markdown() })) } },
            [entry],
            undefined,
            url,
        )
        const [item] = await content.list()
        expect(item?.path).toBe('/posts/post')
        expect(item?.data).toMatchObject({
            _siteAdmin: { id: 'entry', revisionId: 'revision', path: '/posts/post' },
            body: { frontmatter: { title: 'Frontmatter' }, meta: { summary: [['p', {}, 'Intro']] } },
        })
        const data = item!.data as { body: { nodes: Node[] }; sections: { body: { nodes: Node[] } }[] }
        expect(elements(data.body.nodes, 'img')[0]?.[1].src).toBe(url('a'))
        expect(elements(data.sections[0]!.body.nodes, 'img')[0]?.[1].src).toBe(url('a'))
        expect(entry.data).toEqual({ body, sections: [{ body }] })
    })
})
