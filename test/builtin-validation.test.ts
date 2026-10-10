import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
    array,
    createSiteAdminDescriptor,
    datetime,
    defineSiteAdminConfig,
    number,
    object,
    relation,
    text,
    url,
} from '../packages/site-admin/src'
import { useSiteAdminForm } from '../packages/site-admin/src/form'
import { validateModelData } from '../packages/site-admin/src/validation'

const config = defineSiteAdminConfig({
    models: {
        posts: {
            fields: {
                count: number({ integer: true, min: 1, max: 5 }),
                link: url(),
                at: datetime(),
                code: text({ pattern: '^[A-Z]+$' }),
                parent: relation('parents'),
                nested: object({ links: array(url()) }),
                invalidPattern: text({ pattern: '[' }),
            },
        },
        parents: { fields: {} },
    },
})
const descriptor = createSiteAdminDescriptor(config).models.posts!

describe('shared built-in form/server validation', () => {
    it.each([
        [{ count: 1.5 }, 'Must be an integer.'],
        [{ count: Number.POSITIVE_INFINITY }, 'Must be a finite number.'],
        [{ count: 0 }, 'Must be at least 1.'],
        [{ link: 'ftp://example.test/file' }, 'Must be an absolute HTTP(S) URL.'],
        [{ link: '/relative' }, 'Must be an absolute HTTP(S) URL.'],
        [{ at: 'not a date' }, 'Must be an ISO-compatible date-time string.'],
        [{ code: 'lowercase' }, 'Has an invalid format.'],
        [{ parent: '' }, 'Must be an Entry ID.'],
        [{ nested: { links: ['javascript:alert(1)'] } }, 'Must be an absolute HTTP(S) URL.'],
        [{ invalidPattern: 'input' }, 'The configured pattern is invalid.'],
    ] satisfies Array<[Record<string, unknown>, string]>)(
        'rejects %j before sending a mutation',
        async (data, message) => {
            const result = await validateModelData(config.models.posts, data)
            expect(result.issues.some((issue) => issue.message === message)).toBe(true)
            const fetch = vi.fn(async () =>
                Response.json({ id: 'unused', model: 'posts', version: 1, sortOrder: null }),
            )
            const controller = useSiteAdminForm<Record<string, unknown>>({
                modelName: 'posts',
                descriptor,
                defaultValues: data,
                fetch,
            })
            await controller.form.handleSubmit()
            expect(fetch).not.toHaveBeenCalled()
            expect(JSON.stringify(controller.form.state.errors)).toContain(message)
            if ('nested' in data) expect(result.issues[0]?.path).toBe('nested.links.0')
        },
    )
    it('preserves valid built-in values and leaves Standard Schema transformations on the server', async () => {
        const data = {
            count: 2,
            link: 'https://example.test',
            at: '2026-10-09T12:00:00Z',
            code: 'ABC',
            parent: 'parent',
        }
        expect(await validateModelData(config.models.posts, data)).toEqual({ data, issues: [] })
        const fetch = vi.fn(async () => Response.json({ id: 'saved', model: 'posts', version: 1, sortOrder: null }))
        const controller = useSiteAdminForm<Record<string, unknown>>({
            modelName: 'posts',
            descriptor,
            defaultValues: data,
            fetch,
        })
        await controller.form.handleSubmit()
        expect(fetch).toHaveBeenCalledOnce()
        const transformed = { fields: { count: number({ integer: true, validate: z.number().transform(() => 1.5) }) } }
        expect(await validateModelData(transformed, { count: 2 })).toEqual({
            issues: [{ path: 'count', message: 'Must be an integer.' }],
        })
    })
})
