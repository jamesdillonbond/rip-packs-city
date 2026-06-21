// app/nba/fast-break/layout.tsx
//
// SEO surface for the public Fast Break optimizer. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export
// metadata directly).

import type { Metadata } from "next"
import { redirect } from "next/navigation"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "NBA Top Shot Fast Break Lineup Optimizer | Rip Packs City",
  description:
    "Daily optimal Fast Break lineups for NBA Top Shot Playoffs. Top projected fantasy scorers, captain picks, and matchup analysis — updated every 15 minutes. Free.",
  keywords: [
    "NBA Top Shot Fast Break",
    "Fast Break optimizer",
    "NBA Top Shot lineup",
    "NBA Top Shot Playoffs",
    "NBA fantasy lineup",
    "Top Shot Fast Break tonight",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/nba/fast-break`,
  },
  openGraph: {
    title: "NBA Top Shot Fast Break Lineup Optimizer",
    description:
      "Daily optimal Fast Break lineups for NBA Top Shot Playoffs — updated every 15 minutes.",
    url: `${SITE_URL}/nba/fast-break`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/fast-break`,
        width: 1200,
        height: 630,
        alt: "Today's optimal NBA Top Shot Fast Break lineup",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NBA Top Shot Fast Break Lineup Optimizer",
    description:
      "Daily optimal Fast Break lineups for NBA Top Shot Playoffs — updated every 15 minutes.",
    images: [`${SITE_URL}/api/og/fast-break`],
    creator: "@RipPacksCity",
  },
}

export default function FastBreakLayout({ children }: { children: React.ReactNode }) {
  // Hidden for launch - Fast Break feature parked. Remove this redirect (or revert) to re-enable.
  redirect("/")
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "NBA Top Shot Fast Break Lineup Optimizer",
    url: `${SITE_URL}/nba/fast-break`,
    description:
      "Optimal daily lineups for NBA Top Shot Fast Break, recalculated every 15 minutes from DraftKings projections.",
    applicationCategory: "SportsApplication",
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
