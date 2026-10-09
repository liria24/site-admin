import type { ResolvedSiteAdminConfig, SiteAdminConfigInput } from './config'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

// Domain values merge recursively; arrays replace, functions and instances keep identity.
// Files SDK independently resolves physical storage/providers from its selected source file.
const mergeDomainValues = (override: unknown, base: unknown, path: string[] = []): unknown => {
    if (override === undefined) return base
    // Adapters and SDK models are application-owned opaque values, never method bags to merge.
    const seoImage =
        (path.length === 2 && path[0] === 'seo' && path[1] === 'image') ||
        (path.length === 4 &&
            (path[0] === 'models' || path[0] === 'routeRules') &&
            path[2] === 'seo' &&
            path[3] === 'image')
    const aiOpaque =
        path[0] === 'ai' &&
        ((path.length === 2 && (path[1] === 'model' || path[1] === 'decisionModel')) ||
            (path[1] === 'actions' && path.length === 4 && (path[3] === 'model' || path[3] === 'output')) ||
            (path[1] === 'actions' && path.length === 5 && path[3] === 'props'))
    if (path[0] === 'database' || aiOpaque || seoImage) return override
    if (!isRecord(override) || !isRecord(base)) return override
    const result: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override))
        result[key] = mergeDomainValues(value, result[key], [...path, key])
    return result
}

/** Apply Files-compatible environment names/precedence to Site Admin domain configuration. */
export const resolveSiteAdminConfig = <
    const Config extends SiteAdminConfigInput,
    const Environments extends readonly string[],
>(
    config: Config,
    environments: Environments,
): ResolvedSiteAdminConfig<Config, Environments> => {
    let resolved: Record<string, unknown> = Object.fromEntries(Object.entries(config))
    for (const environment of environments) {
        const direct = config[`$${environment}` as keyof Config]
        const named = config.$env?.[environment]
        resolved = mergeDomainValues(isRecord(direct) ? direct : {}, resolved) as Record<string, unknown>
        resolved = mergeDomainValues(isRecord(named) ? named : {}, resolved) as Record<string, unknown>
    }
    return Object.fromEntries(
        Object.entries(resolved).filter(([key]) => !key.startsWith('$')),
    ) as unknown as ResolvedSiteAdminConfig<Config, Environments>
}
