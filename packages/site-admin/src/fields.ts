import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface AssetValue {
    id: string
    alt?: string
    caption?: string
}

export type AssetInput = string | AssetValue

export interface PublicAsset extends AssetValue {
    url: string
}

export interface BaseFieldOptions<Value> {
    default?: Value
    description?: string
    label?: string
    required?: boolean
    validate?: StandardSchemaV1<unknown, Value>
}

export interface StringFieldOptions extends BaseFieldOptions<string> {
    maxLength?: number
    minLength?: number
    pattern?: string
}

export interface NumberFieldOptions extends BaseFieldOptions<number> {
    integer?: boolean
    max?: number
    min?: number
}

export interface AssetFieldOptions extends BaseFieldOptions<AssetInput> {
    accept?: readonly string[]
}

export interface Field<Kind extends string, Value> {
    readonly kind: Kind
    readonly __value?: Value
}

export type TextField = Field<'text', string> & StringFieldOptions
export type TextareaField = Field<'textarea', string> & StringFieldOptions
export type MarkdownField = Field<'markdown', string> & StringFieldOptions
export type NumberField = Field<'number', number> & NumberFieldOptions
export type BooleanField = Field<'boolean', boolean> & BaseFieldOptions<boolean>
export type DatetimeField = Field<'datetime', string> & BaseFieldOptions<string>
export type UrlField = Field<'url', string> & StringFieldOptions
export type FileField = Field<'file', AssetInput> & AssetFieldOptions
export type ImageField = Field<'image', AssetInput> & AssetFieldOptions

export type SelectField<Values extends readonly string[] = readonly string[]> = Field<'select', Values[number]> &
    BaseFieldOptions<Values[number]> & {
        values: Values
    }

export type RelationField<Model extends string = string> = Field<'relation', string> &
    BaseFieldOptions<string> & {
        model: Model
    }

export type ObjectField<Fields extends FieldRecord> = Field<'object', InferFields<Fields>> &
    BaseFieldOptions<InferFields<Fields>> & {
        fields: Fields
    }

export type ArrayField<Item extends AnyField> = Field<'array', InferField<Item>[]> &
    BaseFieldOptions<InferField<Item>[]> & {
        item: Item
        maxItems?: number
        minItems?: number
    }

export type ImagesField = Field<'images', AssetInput[]> &
    BaseFieldOptions<AssetInput[]> & {
        accept?: readonly string[]
        maxItems?: number
        minItems?: number
    }

type NestedObjectField = Field<'object', Record<string, unknown>> &
    BaseFieldOptions<Record<string, unknown>> & {
        fields: FieldRecord
    }

type NestedArrayField = Field<'array', unknown[]> &
    BaseFieldOptions<unknown[]> & {
        item: AnyField
        maxItems?: number
        minItems?: number
    }

export type AnyField =
    | NestedArrayField
    | BooleanField
    | DatetimeField
    | FileField
    | ImageField
    | ImagesField
    | MarkdownField
    | NumberField
    | NestedObjectField
    | RelationField
    | SelectField
    | TextareaField
    | TextField
    | UrlField

export interface FieldRecord {
    [name: string]: AnyField
}

export type InferField<F extends AnyField> = F extends Field<string, infer Value> ? Value : never

type RequiredKeys<Fields extends FieldRecord> = {
    [Key in keyof Fields]-?: Fields[Key] extends { required: true } ? Key : never
}[keyof Fields]

type OptionalKeys<Fields extends FieldRecord> = Exclude<keyof Fields, RequiredKeys<Fields>>

export type InferFields<Fields extends FieldRecord> = {
    [Key in RequiredKeys<Fields>]: InferField<Fields[Key]>
} & {
    [Key in OptionalKeys<Fields>]?: InferField<Fields[Key]> | null
}

const scalar = <Kind extends string, Value, Options extends object>(kind: Kind, options?: Options) =>
    ({ kind, ...options }) as Field<Kind, Value> & Options

export const text = <const Options extends StringFieldOptions = StringFieldOptions>(
    options?: Options,
): TextField & Options => scalar<'text', string, Options>('text', options)

export const textarea = <const Options extends StringFieldOptions = StringFieldOptions>(
    options?: Options,
): TextareaField & Options => scalar<'textarea', string, Options>('textarea', options)

export const markdown = <const Options extends StringFieldOptions = StringFieldOptions>(
    options?: Options,
): MarkdownField & Options => scalar<'markdown', string, Options>('markdown', options)

export const number = <const Options extends NumberFieldOptions = NumberFieldOptions>(
    options?: Options,
): NumberField & Options => scalar<'number', number, Options>('number', options)

export const boolean = <const Options extends BaseFieldOptions<boolean> = BaseFieldOptions<boolean>>(
    options?: Options,
): BooleanField & Options => scalar<'boolean', boolean, Options>('boolean', options)

export const datetime = <const Options extends BaseFieldOptions<string> = BaseFieldOptions<string>>(
    options?: Options,
): DatetimeField & Options => scalar<'datetime', string, Options>('datetime', options)

export const url = <const Options extends StringFieldOptions = StringFieldOptions>(
    options?: Options,
): UrlField & Options => scalar<'url', string, Options>('url', options)

export const select = <
    const Values extends readonly string[],
    const Options extends BaseFieldOptions<Values[number]> = BaseFieldOptions<Values[number]>,
>(
    values: Values,
    options?: Options,
): SelectField<Values> & Options => ({ kind: 'select', values, ...options }) as unknown as SelectField<Values> & Options

export const relation = <
    const Model extends string,
    const Options extends BaseFieldOptions<string> = BaseFieldOptions<string>,
>(
    modelName: Model,
    options?: Options,
): RelationField<Model> & Options =>
    ({ kind: 'relation', model: modelName, ...options }) as unknown as RelationField<Model> & Options

export const object = <
    const Fields extends FieldRecord,
    const Options extends BaseFieldOptions<InferFields<Fields>> = BaseFieldOptions<InferFields<Fields>>,
>(
    fields: Fields,
    options?: Options,
): ObjectField<Fields> & Options => ({ kind: 'object', fields, ...options }) as unknown as ObjectField<Fields> & Options

export const array = <
    const Item extends AnyField,
    const Options extends BaseFieldOptions<InferField<Item>[]> & { maxItems?: number; minItems?: number } =
        BaseFieldOptions<InferField<Item>[]> & { maxItems?: number; minItems?: number },
>(
    item: Item,
    options?: Options,
): ArrayField<Item> & Options => ({ kind: 'array', item, ...options }) as unknown as ArrayField<Item> & Options

export const file = <const Options extends AssetFieldOptions = AssetFieldOptions>(
    options?: Options,
): FileField & Options => scalar<'file', AssetInput, Options>('file', options)

export const image = <const Options extends AssetFieldOptions = AssetFieldOptions>(
    options?: Options,
): ImageField & Options => scalar<'image', AssetInput, Options>('image', options)

export const images = <
    const Options extends BaseFieldOptions<AssetInput[]> & {
        accept?: readonly string[]
        maxItems?: number
        minItems?: number
    } = BaseFieldOptions<AssetInput[]> & {
        accept?: readonly string[]
        maxItems?: number
        minItems?: number
    },
>(
    options?: Options,
): ImagesField & Options => scalar<'images', AssetInput[], Options>('images', options)
