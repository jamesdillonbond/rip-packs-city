// app/insights/pack-drops/layout.tsx
//
// SEO surface for the public Pack Drops board. Server component so the metadata
// export is honored (a "use client" page.tsx can't export metadata). The
// canonical is param-stripped (always /insights/pack-drops). Mirrors
// app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Pack Drops — Is This Re-Pack Worth It?",
  description:
    "Vaultopolis re-pack drops of real NBA Top Shot moments, scored against RPC FMV. RPC pool, pack EV vs the FLOW price, value concentration, and odds — the 'is this worth it?' read no marketplace ships. Free. No signup.",
  keywords: [
    "Vaultopolis pack drops",
    "Top Shot re-pack value",
    "Top Shot pack EV",
    "is this Top Shot pack worth it",
    "Vaultopolis drop FMV",
    "NBA Top Shot pack expected value",
    "Flow blockchain re-pack intelligence",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/pack-drops`,
  },
  openGraph: {
    title: "Pack Drops — Is This Re-Pack Worth It?",
    description:
      "Vaultopolis re-pack drops scored against RPC FMV — RPC pool, pack EV vs the FLOW price, value concentration, and odds.",
    url: `${SITE_URL}/insights/pack-drops`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pack-drops`,
        width: 1200,
        height: 630,
        alt: "Pack Drops — Is This Re-Pack Worth It? — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Pack Drops — Is This Re-Pack Worth It?",
    description:
      "Vaultopolis re-pack drops scored against RPC FMV. Pack EV vs the FLOW price. Free, no signup.",
    images: [`${SITE_URL}/api/og/insights/pack-drops`],
    creator: "@RipPacksCity",
  },
}

export default function PackDropsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("pack-drops")
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
