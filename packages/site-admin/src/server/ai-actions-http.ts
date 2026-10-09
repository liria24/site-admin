import { SiteAdminError } from '../errors'

export const handleAiActionRequest = async (
    request: Request,
    base: string,
    execute: (name: string, input: unknown) => Promise<unknown>,
): Promise<Response> => {
    const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
        vary: 'Cookie',
    }
    try {
        if (request.method !== 'POST')
            return new Response(
                JSON.stringify({ error: { code: 'SITE_ADMIN_INVALID_INPUT', message: 'POST required.' } }),
                { status: 405, headers: { ...headers, allow: 'POST' } },
            )
        const url = new URL(request.url)
        const origin = request.headers.get('origin')
        const site = request.headers.get('sec-fetch-site')
        if (origin !== null ? origin !== url.origin : site !== null && site !== 'same-origin')
            throw new SiteAdminError('SITE_ADMIN_FORBIDDEN', 'AI actions require the same origin.')
        const prefix = base.replace(/\/$/u, '') + '/ai/actions/'
        const suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
        if (!suffix || suffix.includes('/'))
            throw new SiteAdminError('SITE_ADMIN_ENTRY_NOT_FOUND', 'AI action does not exist.')
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Content-Type must be application/json.')
        let input: unknown
        try {
            input = await request.json()
        } catch {
            throw new SiteAdminError('SITE_ADMIN_INVALID_INPUT', 'Invalid JSON.')
        }
        return new Response(JSON.stringify(await execute(decodeURIComponent(suffix), input)), { headers })
    } catch (error) {
        const known =
            error instanceof SiteAdminError ? error : new SiteAdminError('SITE_ADMIN_AI_FAILED', 'AI action failed.')
        return new Response(
            JSON.stringify({
                error: { code: known.code, message: known.message, ...(known.issues ? { issues: known.issues } : {}) },
            }),
            { status: known.status, headers },
        )
    }
}
