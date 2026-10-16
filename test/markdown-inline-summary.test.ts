import { expect, it } from 'vitest'
import { paragraphSummary } from '../packages/site-admin/src/markdown/summary'

it('preserves explicitly configured inline nodes without allowing other components or changing the prose budget', () => {
    const nodes = [
        [
            'p',
            {},
            'Playing ',
            ['game-mention', { slug: 'example-game' }, 'Example game'],
            ['admin-panel', {}, 'Secret'],
        ],
    ] as const
    const source = structuredClone(nodes) as unknown as import('comark').Node[]
    expect(paragraphSummary(source)).toEqual([['p', {}, 'Playing ']])
    expect(paragraphSummary(source, ['game-mention'])).toEqual([
        ['p', {}, 'Playing ', ['game-mention', { slug: 'example-game' }, 'Example game']],
    ])
    expect(
        paragraphSummary([['p', {}, ['game-mention', { slug: 'example-game' }, 'Example game']]], ['game-mention']),
    ).toHaveLength(1)
    expect(
        paragraphSummary(
            [['p', {}, 'x'.repeat(280), ['game-mention', { slug: 'example-game' }, 'Example game']]],
            ['game-mention'],
        ),
    ).toEqual([['p', {}, 'x'.repeat(280)]])
})
