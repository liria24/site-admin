import type { Translations } from '../i18n'

/** Derived text only; canonical content remains in revision records. */
export const searchRecords = (data: Record<string, unknown>, defaultLocale: string, translations: Translations) =>
    [defaultLocale, ...Object.keys(translations)].flatMap((locale) => {
        const points = Array.from(JSON.stringify({ ...data, ...translations[locale] }).toLowerCase())
        const records: Array<{ locale: string; part: number; value: string }> = []
        for (let offset = 0; offset < points.length; offset += 131_072)
            records.push({ locale, part: offset / 131_072, value: points.slice(offset, offset + 131_072).join('') })
        return records
    })

/** Include adjacent-part boundaries without changing Unicode substring semantics. */
export const searchPredicate = (q: string) => ({
    sql: `EXISTS (SELECT 1 FROM site_admin_search c
        LEFT JOIN site_admin_search p ON p.revision_id=c.revision_id AND p.locale=c.locale AND p.part=c.part-1
        WHERE c.part>=0 AND c.revision_id=r.id AND c.locale=COALESCE((SELECT t.locale FROM site_admin_translations t WHERE t.revision_id=r.id AND t.locale=?),e.default_locale)
        AND instr(COALESCE(substr(p.value,max(1,length(p.value)-?+2)),'')||c.value,?)>0)`,
    length: Array.from(q).length,
})
