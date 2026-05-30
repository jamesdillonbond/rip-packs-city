// app/insights/layout.tsx
//
// SEO surface for the public /insights index. Server component so the
// metadata export is honored. Per-page metadata under /insights/<x>/layout.tsx
// overrides this index-level default.

import type { Metadata } from "next"
import InsightsEmailCapture from "@/components/insights/InsightsEmailCapture"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Public Insights — Rip Packs City",
  description:
    "Free, no-signup intelligence on Flow blockchain digital collectibles. Effective supply, pack reality, rookie cohort tracking, first-mint trophies, cross-collection whales, per-set scarcity, Pinnacle scarcity.",
  alternates: { canonical: `${SITE_URL}/insights` },
  openGraph: {
    title: "Public Insights — Rip Packs City",
    description:
      "Seven wedges of intelligence the marketplace structurally can't (or won't) ship, plus a wallet tool.",
    url: `${SITE_URL}/insights`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights`,
        width: 1200,
        height: 630,
        alt: "Public Insights — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Public Insights — Rip Packs City",
    description:
      "Things Top Shot won't tell you. Free, no signup.",
    images: [`${SITE_URL}/api/og/insights`],
    creator: "@RipPacksCity",
  },
}

export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <InsightsEmailCapture />
    </>
  )
}
