import { expect, it } from 'vitest'
import { z } from 'zod'
import { array, text } from '../packages/site-admin/src'
import { prepareTranslations } from '../packages/site-admin/src/server/translations'

it('keeps locale-specific validation outputs while leaving unchanged fallback fields sparse', async () => {
    const definition = {
        fields: {
            title: text({ required: true, i18n: true }),
            plainTitle: text({ i18n: true }),
            mentions: array(text(), { i18n: true }),
            fallback: text({ i18n: true }),
            shared: text(),
        },
        validate: z
            .object({
                title: z.string(),
                plainTitle: z.string().optional(),
                mentions: z.array(z.string()).optional(),
                fallback: z.string().optional(),
                shared: z.string().optional(),
            })
            .transform(async (data) => ({ ...data, plainTitle: data.title.toUpperCase(), mentions: [data.title] })),
    }
    const original = {
        title: 'original',
        plainTitle: 'ORIGINAL',
        mentions: ['original'],
        fallback: 'shared fallback',
        shared: 'shared',
    }
    const translated = await prepareTranslations(definition, original, 'ja', ['ja', 'en', 'fr'], {
        en: { title: 'english' },
        fr: { fallback: 'French fallback' },
    })
    expect(translated).toEqual({
        en: { title: 'english', plainTitle: 'ENGLISH', mentions: ['english'] },
        fr: { fallback: 'French fallback' },
    })
    expect(
        await prepareTranslations(
            definition,
            { ...original, fallback: 'updated fallback' },
            'ja',
            ['ja', 'en', 'fr'],
            {},
            translated,
        ),
    ).toEqual(translated)
    expect(await prepareTranslations(definition, original, 'ja', ['ja', 'en', 'fr'], { en: null }, translated)).toEqual(
        { fr: { fallback: 'French fallback' } },
    )
})
