import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth'
import { admin, createAccessControl } from 'better-auth/plugins'
import { defaultRoles, defaultStatements } from 'better-auth/plugins/admin/access'
import type { AdminOptions } from 'better-auth/plugins/admin'

type Statements = Record<string, readonly string[]>
type AuthPlugins<T> = T extends { plugins: infer P extends readonly BetterAuthPlugin[] } ? P : []
type AdminPlugin = ReturnType<typeof admin<AdminOptions>>

/** Extend the application's native admin instance before Better Auth builds its schema and adapter. */
export const extendSiteAdminAuth = <const T extends BetterAuthOptions>(
    options: T,
    resources: Statements,
    permissions: Record<string, Statements>,
): Omit<T, 'plugins'> & { plugins: Array<AuthPlugins<T>[number] | AdminPlugin> } => {
    const plugins = options.plugins ?? []
    const admins = plugins.filter((plugin) => plugin.id === 'admin')
    if (admins.length > 1) throw new Error('[site-admin] Configure a single native Better Auth admin plugin.')
    const existing = admins[0] as AdminPlugin | undefined
    const nativeOptions = existing?.options
    const cmsResources = Object.fromEntries(Object.entries(resources).filter(([name]) => name.startsWith('siteAdmin:')))
    const ac = createAccessControl({ ...defaultStatements, ...nativeOptions?.ac?.statements, ...cmsResources })
    const nativeRoles: NonNullable<AdminOptions['roles']> = nativeOptions?.roles ?? defaultRoles
    const roles = Object.fromEntries(
        [...new Set([...Object.keys(nativeRoles), ...Object.keys(permissions)])].map((name) => [
            name,
            ac.newRole({
                ...nativeRoles[name]?.statements,
                ...Object.fromEntries(
                    Object.keys(cmsResources).map((resource) => [resource, permissions[name]?.[resource] ?? []]),
                ),
            }),
        ]),
    )
    const plugin = admin({ ...nativeOptions, ac, roles })
    // The app may have an independent Better Auth module copy or an explicit native schema extension.
    if (existing) plugin.schema = existing.schema
    return {
        ...options,
        plugins: [...plugins.filter((item) => item.id !== 'admin'), plugin],
    } as Omit<T, 'plugins'> & { plugins: Array<AuthPlugins<T>[number] | AdminPlugin> }
}
