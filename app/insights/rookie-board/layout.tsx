// app/insights/rookie-board/layout.tsx
//
// SEO surface for the public Rookie Edition Board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// Canonical is param-stripped (always /insights/rookie-board) so the
// ?mode= / ?tier= / ?parallel= / ?player= filtered URLs don't index as
// duplicate content. Mirrors app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 & 2026 Classes",
  description:
    "Every 2025 and 2026 NBA Top Shot rookie edition broken out by parallel — Standard, Hexwave, Jukebox, Galactic, Omega — with per-parallel FMV, circulation, ask, burn and lock rates. Free. No signup.",
  keywords: [
    "NBA Top Shot rookie tracker",
    "2025 rookie class Top Shot",
    "2026 rookie class Top Shot",
    "Top Shot rookie parallels",
    "Cooper Flagg Top Shot",
    "Top Shot Hexwave Jukebox value",
    "Top Shot rookie burn rate",
    "Top Shot rookie FMV",
    "Flow blockchain rookie moments",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/rookie-board`,
  },
  openGraph: {
    title: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 & 2026 Classes",
    description:
      "Every 2025 and 2026 Top Shot rookie edition by parallel, with per-parallel FMV priced from that printing's own sales, circulation, burn and lock rates.",
    url: `${SITE_URL}/insights/rookie-board`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/rookie-board`,
        width: 1200,
        height: 630,
        alt: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 & 2026 Classes — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Rookie Board — Per-Parallel FMV, Burn & Lock",
    description:
      "Every 2025 and 2026 Top Shot rookie edition by parallel, with per-parallel FMV priced from that printing's own sales, circulation, burn and lock rates.",
    images: [`${SITE_URL}/api/og/insights/rookie-board`],
    creator: "@RipPacksCity",
  },
}

export default function RookieBoardLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("rookie-board")
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      {children}
    </>
  )
}
