// app/insights/tc-report/layout.tsx
//
// SEO surface for the Top Collector Report wallet tool. Sibling to
// squeeze-check/layout.tsx. Sets a self-referencing, param-stripped canonical
// so the ?wallet= filtered URLs don't get indexed as duplicate content — the
// bare /insights/tc-report path is the indexable tool landing. Uses the
// text-only default card at /api/og/insights/tc-report (app/api/og/insights/[slug],
// 2026-10-11) — it used to borrow the generic /insights HUB card.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Top Collector Report",
  description:
    "Full bag analytics for any Flow wallet — squeeze exposure, set completion, cross-collection footprint, rookie + WNBA coverage, and recent acquisitions. Top Shot shows you what you own; we show you what it means. Free. No signup.",
  keywords: [
    "NBA Top Shot wallet report",
    "Top Shot collection analytics",
    "Top Shot set completion",
    "Flow wallet analysis",
    "cross-collection footprint",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/tc-report` },
  openGraph: {
    title: "Top Collector Report",
    description:
      "Full bag analytics for any Flow wallet — squeeze, set completion, cross-collection footprint, rookie + WNBA coverage.",
    url: `${SITE_URL}/insights/tc-report`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/tc-report`,
        width: 1200,
        height: 630,
        alt: "Top Collector Report — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Top Collector Report",
    description:
      "Full bag analytics for any Flow wallet — squeeze, set completion, cross-collection footprint.",
    images: [`${SITE_URL}/api/og/insights/tc-report`],
    creator: "@RipPacksCity",
  },
}

export default function TcReportLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("tc-report")
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </>
  )
}
