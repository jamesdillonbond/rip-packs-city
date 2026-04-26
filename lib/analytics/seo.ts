import type { Metadata } from "next"

export const ANALYTICS_BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://rippackscity.com"

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
      title,
      description,
      type: "website",
      url: canonical,
      siteName: "Rip Packs City",
      images: [{ url: ogImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  }
}
