// app/insights/layout.tsx
//
// SEO surface for the public /insights index. Server component so the
// metadata export is honored. Per-page metadata under /insights/<x>/layout.tsx
// overrides this index-level default.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Public Insights — Rip Packs City",
  description:
    "Free, no-signup intelligence on Flow blockchain digital collectibles. Effective supply, pack reality, rookie cohort tracking.",
  alternates: { canonical: `${SITE_URL}/insights` },
  openGraph: {
    title: "Public Insights — Rip Packs City",
    description:
      "Free, no-signup intelligence on Flow blockchain digital collectibles.",
    url: `${SITE_URL}/insights`,
    siteName: "Rip Packs City",
    locale: "en_US",
    type: "website",
  },
}

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return children
}
