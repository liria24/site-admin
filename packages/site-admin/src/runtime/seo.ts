import { useSeoMeta, useRoute, useRuntimeConfig, useRequestURL, useHead, useNuxtApp, tryUseNuxtApp } from '#app'
import { computed, toValue, getCurrentScope, ref, watch, type MaybeRefOrGetter } from 'vue'
import { createSiteAdminRouteResolver, mergeSiteAdminSeo, type SiteAdminRouteRules } from '../seo'
import type { PublicEntrySeo } from '../server/types'

type PageSeoOptions<Image> = Omit<PublicEntrySeo, 'image'> & { image?: string | false | Image }

export const createSeoMetadata =
    <Image = never>(options: { seo: boolean; generateImage?: (image: Image) => void }) =>
    (
        input: MaybeRefOrGetter<PublicEntrySeo | PageSeoOptions<Image> | null | undefined> = {},
        pageOverride?: MaybeRefOrGetter<PageSeoOptions<Image> | null | undefined>,
        headPriority?: 'critical',
        presentation?: MaybeRefOrGetter<{ defaults?: PublicEntrySeo; route?: PublicEntrySeo } | undefined>,
    ): void => {
        const config = (useRuntimeConfig().public.siteAdmin ?? {}) as {
            seo?: PublicEntrySeo
            routeRules?: SiteAdminRouteRules
        }
        const route = useRoute()
        const origin = useRequestURL().origin
        const resolveRoute = createSiteAdminRouteResolver(config.routeRules)
        const resolved = computed(() =>
            mergeSiteAdminSeo<PublicEntrySeo | PageSeoOptions<Image>>(
                toValue(presentation)?.defaults ?? config.seo,
                toValue(input) ?? undefined,
                toValue(presentation)?.route ?? resolveRoute(route.path).seo,
                toValue(pageOverride) ?? undefined,
            ),
        )
        const ownsComponentImage = ref(false)
        if (options.generateImage) {
            const nuxtApp = useNuxtApp()
            const scope = getCurrentScope()
            watch(
                () => resolved.value.image,
                (image) => {
                    if (!image || typeof image !== 'object' || (scope && !scope.active)) return
                    const apply = () => {
                        options.generateImage!(image as Image)
                        ownsComponentImage.value = true
                    }
                    const withContext = () => (tryUseNuxtApp() === nuxtApp ? apply() : nuxtApp.runWithContext(apply))
                    if (scope) void scope.run(withContext)
                    else void withContext()
                },
                { immediate: true, deep: true },
            )
        }
        // Native OG tags resolve lazily at high priority; explicit metadata must win.
        const priority = { tagPriority: 'critical' as const }
        const clearImage = () =>
            resolved.value.image === false || (resolved.value.image === undefined && ownsComponentImage.value)
        const imageUrl = () =>
            typeof resolved.value.image === 'string' ? resolved.value.image : clearImage() ? null : undefined
        const clearImageDetails = () => (typeof resolved.value.image === 'string' || clearImage() ? null : undefined)
        const headOptions = headPriority ? { tagPriority: headPriority } : {}
        if (options.seo)
            useSeoMeta(
                { title: () => resolved.value.title, description: () => resolved.value.description },
                headOptions,
            )
        useSeoMeta(
            {
                ...(options.seo ? { robots: () => resolved.value.robots } : {}),
                ogTitle: () => resolved.value.title,
                ogDescription: () => resolved.value.description,
                twitterTitle: () => resolved.value.title,
                twitterDescription: () => resolved.value.description,
                twitterCard: () => resolved.value.twitterCard ?? 'summary_large_image',
                ogType: () => resolved.value.type ?? 'website',
                ogImage: imageUrl,
                twitterImage: imageUrl,
                ogImageType: clearImageDetails,
                ogImageWidth: clearImageDetails,
                ogImageHeight: clearImageDetails,
                ogImageAlt: clearImageDetails,
                ogImageSecureUrl: clearImageDetails,
                twitterImageAlt: clearImageDetails,
            },
            priority,
        )
        if (options.seo)
            useHead(
                () => ({
                    ...(resolved.value.titleTemplate === undefined
                        ? {}
                        : { titleTemplate: resolved.value.titleTemplate }),
                    link: [
                        ...(resolved.value.canonical
                            ? [{ rel: 'canonical' as const, href: new URL(resolved.value.canonical, origin).href }]
                            : []),
                        ...(resolved.value.alternates ?? []).map(({ locale, path }) => ({
                            rel: 'alternate' as const,
                            hreflang: locale,
                            href: new URL(path, origin).href,
                        })),
                    ],
                }),
                headOptions,
            )
    }
