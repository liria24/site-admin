import type { FieldDescriptor, ModelDescriptor } from './descriptor'
import type { AssetValue } from './fields'

/** Presentation URL still uses the authenticated management content route. */
export interface SiteAdminAsset extends AssetValue {
    url: string
}

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const siteAdminAsset = (value: string | AssetValue, url: (id: string) => string): SiteAdminAsset => {
    const asset = typeof value === 'string' ? { id: value } : value
    return {
        id: asset.id,
        url: url(asset.id),
        ...(asset.alt === undefined ? {} : { alt: asset.alt }),
        ...(asset.caption === undefined ? {} : { caption: asset.caption }),
    }
}

const assetCodec = (value: unknown, url?: (id: string) => string): unknown => {
    if (typeof value === 'string') return url ? siteAdminAsset(value, url) : value
    if (!record(value) || typeof value.id !== 'string') return value
    if (url) return siteAdminAsset(value as unknown as AssetValue, url)
    return {
        id: value.id,
        ...(value.alt === undefined ? {} : { alt: value.alt }),
        ...(value.caption === undefined ? {} : { caption: value.caption }),
    }
}

const fieldCodec = (field: FieldDescriptor, value: unknown, url?: (id: string) => string): unknown => {
    if (value === null || value === undefined) return value
    if (field.kind === 'image' || field.kind === 'file') return assetCodec(value, url)
    if (field.kind === 'images' && Array.isArray(value)) return value.map((item) => assetCodec(item, url))
    if (field.kind === 'object' && record(value)) return fieldsCodec(field.fields ?? {}, value, url)
    if (field.kind === 'array' && field.item && Array.isArray(value))
        return value.map((item) => fieldCodec(field.item!, item, url))
    return value
}

const fieldsCodec = (
    fields: Record<string, FieldDescriptor>,
    data: Record<string, unknown>,
    url?: (id: string) => string,
): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(data).map(([name, value]) => [
            name,
            fields[name] ? fieldCodec(fields[name], value, url) : value,
        ]),
    )

export const presentSiteAdminData = <Data extends Record<string, unknown>>(
    descriptor: ModelDescriptor,
    data: Record<string, unknown>,
    url: (id: string) => string,
): Data => fieldsCodec(descriptor.fields, data, url) as Data

/** Only schema-declared assets lose presentation properties; ordinary url fields are preserved. */
export const serializeSiteAdminData = <Data extends Record<string, unknown>>(
    descriptor: ModelDescriptor,
    data: Data,
): Record<string, unknown> => fieldsCodec(descriptor.fields, data)
