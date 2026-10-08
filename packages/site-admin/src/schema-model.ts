import type { SiteAdminConfig } from './config'
import type { AnyField } from './fields'

export const fieldStorage = (field: AnyField): 'text' | 'integer' | 'real' | 'boolean' | 'json' => {
    if (field.kind === 'number') return field.integer ? 'integer' : 'real'
    if (field.kind === 'boolean') return 'boolean'
    if (['object', 'array', 'image', 'images', 'file'].includes(field.kind)) return 'json'
    return 'text'
}

export const contentTableName = (name: string): string => `site_admin_content_${name}`
export const validateContentNames = (config: SiteAdminConfig): void => {
    const models = new Set<string>()
    for (const [name, model] of Object.entries(config.models)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(name) || models.has(name.toLowerCase()))
            throw new Error(`Invalid or duplicate Model name: ${name}`)
        models.add(name.toLowerCase())
        const fields = new Set<string>()
        for (const key of Object.keys(model.fields)) {
            if (!/^[A-Za-z0-9_-]{1,128}$/u.test(key) || key === 'revisionId' || fields.has(key.toLowerCase()))
                throw new Error(`Invalid or reserved field: ${name}.${key}`)
            fields.add(key.toLowerCase())
        }
    }
}
