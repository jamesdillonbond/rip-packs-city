// app/insights/rookie-board/layout.tsx
//
// SEO surface for the public Rookie Edition Board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// Canonical is param-stripped (always /insights/rookie-board) so the
// ?mode= / ?tier= / ?parallel= / ?player= filtered URLs don't index as
// duplicate content. Mirrors app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 Class | Rip Packs City",
  description:
    "Every 2025 NBA Top Shot rookie edition broken out by parallel — Standard, Hexwave, Jukebox, Galactic, Omega — with per-parallel FMV (and a confidence tag), circulation, ask, burn and lock rates. Free. No signup.",
  keywords: [
    "NBA Top Shot rookie tracker",
    "2025 rookie class Top Shot",
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
    title: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 Class",
    description:
      "Every 2025 Top Shot rookie edition by parallel, with per-parallel FMV (confidence-tagged), circulation, burn and lock rates.",
    url: `${SITE_URL}/insights/rookie-board`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/rookie-board`,
        width: 1200,
        height: 630,
        alt: "Rookie Board — Per-Parallel FMV, Burn & Lock for the 2025 Class — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Rookie Board — Per-Parallel FMV, Burn & Lock",
    description:
      "Every 2025 Top Shot rookie edition by parallel, with per-parallel FMV (confidence-tagged), circulation, burn and lock rates.",
    images: [`${SITE_URL}/api/og/insights/rookie-board`],
    creator: "@RipPacksCity",
  },
}

export default function RookieBoardLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Rookie Board — 2025 Class",
    url: `${SITE_URL}/insights/rookie-board`,
    description:
      "Breaks every 2025 NBA Top Shot rookie edition out by parallel with per-parallel FMV, circulation, ask, burn and lock rates from real on-chain data.",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: {
      "@type": "Organization",
      name: "Rip Packs City",
      url: SITE_URL,
    },
  }
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
