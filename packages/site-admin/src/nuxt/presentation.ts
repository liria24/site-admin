import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import type { Nuxt } from 'nuxt/schema'
import { addTemplate } from 'nuxt/kit'

/** Prepare before Nuxt i18n resolves its detector; preserve the application's detector. */
export async function preparePresentation(nuxt: Nuxt) {
    const options = nuxt.options as typeof nuxt.options & {
        i18n?: {
            restructureDir?: string
            experimental?: { localeDetector?: string }
            detectBrowserLanguage?: false | { cookieKey?: string; useCookie?: boolean }
            defaultLocale?: string
            locales?: Array<string | { code: string }>
        }
    }
    const i18n = (options.i18n ??= {})
    i18n.experimental ??= {}
    const path = resolve(nuxt.options.buildDir, 'site-admin/locale-detector.mjs')
    if (i18n.experimental.localeDetector === path) return
    // Nuxt i18n consumes layer configuration before applying the merged options.
    // eslint-disable-next-line no-underscore-dangle
    const layers = nuxt.options._layers as Array<
        (typeof nuxt.options._layers)[number] & { config: { i18n?: typeof i18n } }
    >
    const layer = layers.find((candidate) => candidate.config.i18n?.experimental?.localeDetector)
    const inherited = layer?.config.i18n
    const original = i18n.experimental.localeDetector ?? inherited?.experimental?.localeDetector
    const source = original
        ? resolve(
              layer?.config.rootDir ?? nuxt.options.rootDir,
              inherited?.restructureDir ?? i18n.restructureDir ?? 'i18n',
              original,
          )
        : undefined
    const supported = (i18n.locales ?? []).map((locale) => (typeof locale === 'string' ? locale : locale.code))
    const detection = i18n.detectBrowserLanguage
    const cookie =
        detection !== false && detection?.useCookie !== false ? (detection?.cookieKey ?? 'i18n_redirected') : undefined
    await mkdir(dirname(path), { recursive: true })
    const contents = `import { tryQueryLocale, tryCookieLocale, tryHeaderLocale } from '#imports'
import { requestedPresentationLocale } from '@liria24/site-admin/internal/runtime/presentation'
${source ? `import original from ${JSON.stringify(source.replaceAll('\\', '/'))}` : ''}
export default (event, config) => {
  const explicit = requestedPresentationLocale() ?? tryQueryLocale(event, { lang: '', name: 'uiLocale' })?.toString()
  if (explicit) return explicit
  ${
      source
          ? 'return original(event, config)'
          : `const supported = ${JSON.stringify(supported)}
  const candidates = [${cookie ? `tryCookieLocale(event, { lang: '', name: ${JSON.stringify(cookie)} })?.toString(),` : ''} tryHeaderLocale(event, { lang: '' })?.toString()]
  return candidates.find(locale => supported.includes(locale)) ?? config.defaultLocale`
  }
}
`
    addTemplate({ filename: 'site-admin/locale-detector.mjs', getContents: () => contents, write: true })
    await writeFile(path, contents)
    i18n.experimental.localeDetector = path
    // Nuxt i18n discovers detector files from layer config, rather than the merged module options.
    const rootLayer = layers[0]!
    const rootI18n = (rootLayer.config.i18n ??= {})
    ;(rootI18n.experimental ??= {}).localeDetector = path
}
