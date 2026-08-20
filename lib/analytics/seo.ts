import type { Metadata } from "next"
import { OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"

// ⚠ WHY THE SPREADS BELOW ARE NOT OPTIONAL (deep-audit R10, generalised).
// Next merges page metadata into the root export at the TOP-LEVEL key only, so
// defining `openGraph` / `twitter` here REPLACES the root block outright and
// every field this helper omits vanishes from the rendered tags. This helper
// backs all 17 /analytics surfaces (several of them dynamic), and it sat in the
// blind spot between the two guards that already ban this shape: the tree-walking
// one reads `app/**` only, and the shared-helper one is a CURATED LIST of the
// three builders inside lib/seo.ts. Measured 2026-08-20: it dropped
// `twitter.site`, `twitter.creator` and `openGraph.locale` — i.e. the X byline,
// on the pages this repo calls its most shareable surface. Fields are SPREAD from
// the exported constants, never restated, so adding one at the root widens this
// for free.

export const ANALYTICS_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const DEFAULT_OG = "/api/og/default"

interface AnalyticsMetaInput {
  title: string
  description: string
  path: string
  ogImage?: string
}

export function analyticsMetadata({
  title,
  description,
  path,
  ogImage = DEFAULT_OG,
}: AnalyticsMetaInput): Metadata {
  const canonical = `${ANALYTICS_BASE_URL}${path}`
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      ...OG_INHERITED,
      title,
      description,
      url: canonical,
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      ...TWITTER_INHERITED,
      title,
      description,
      images: [ogImage],
    },
  }
}
