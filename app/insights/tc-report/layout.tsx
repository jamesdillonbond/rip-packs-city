// app/insights/tc-report/layout.tsx
//
// SEO surface for the Top Collector Report wallet tool. Sibling to
// squeeze-check/layout.tsx. Sets a self-referencing, param-stripped canonical
// so the ?wallet= filtered URLs don't get indexed as duplicate content — the
// bare /insights/tc-report path is the indexable tool landing. Uses the
// generic /api/og/insights card (there is no tc-report-specific OG route).

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Collector Report | Rip Packs City",
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
        url: `${SITE_URL}/api/og/insights`,
        width: 1200,
        height: 630,
        alt: "Top Collector Report — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Collector Report",
    description:
      "Full bag analytics for any Flow wallet — squeeze, set completion, cross-collection footprint.",
    images: [`${SITE_URL}/api/og/insights`],
    creator: "@RipPacksCity",
  },
}

export default function TcReportLayout({ children }: { children: React.ReactNode }) {
  return children
}
