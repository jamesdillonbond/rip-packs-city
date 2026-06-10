// app/insights/pack-sniper/layout.tsx
//
// SEO surface for the public Pack Sniper deal board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Pack Sniper — Sealed Pack Deals vs Expected Value | Rip Packs City",
  description:
    "Top Shot shows a sealed pack's low ask. We show the ask against the pack's expected pull value. The Pack Sniper ranks currently-listed NBA Top Shot sealed packs by live ask vs EV — with a high-variance flag so chance-hit lottery packs are labelled, not promoted. Free. No signup.",
  keywords: [
    "Top Shot pack deals",
    "NBA Top Shot sealed packs",
    "Top Shot pack EV",
    "Top Shot pack expected value",
    "Top Shot pack sniper",
    "NBA Top Shot pack value",
    "NFL All Day pack deals",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/pack-sniper`,
  },
  openGraph: {
    title: "Pack Sniper — Sealed Pack Deals vs Expected Value",
    description:
      "Currently-listed Top Shot sealed packs ranked by live ask vs expected pull value. Chance-hit lottery packs flagged, not promoted.",
    url: `${SITE_URL}/insights/pack-sniper`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights`,
        width: 1200,
        height: 630,
        alt: "Pack Sniper — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pack Sniper — Sealed Pack Deals vs Expected Value",
    description:
      "Currently-listed Top Shot sealed packs ranked by live ask vs expected pull value. Lottery packs flagged.",
    images: [`${SITE_URL}/api/og/insights`],
    creator: "@RipPacksCity",
  },
}

export default function PackSniperLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Pack Sniper — Sealed Pack Deals vs Expected Value",
    url: `${SITE_URL}/insights/pack-sniper`,
    description:
      "Ranks currently-listed NBA Top Shot (and NFL All Day) sealed packs by live secondary ask versus drop-weighted expected pull value. Refreshes every few minutes.",
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
