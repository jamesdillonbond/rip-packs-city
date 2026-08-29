// app/insights/offer-spread/layout.tsx
//
// SEO surface for the public Bid vs Floor board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// Canonical is param-stripped so ?player=/?set=/?tier= drill-downs don't index
// as duplicates (QA point 5). Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Bid vs Floor — Top Shot Offer/Ask Spread",
  description:
    "Top Shot editions where the top standing offer meets or approaches the floor ask — liquidity and bid-vs-floor intelligence. Free. No signup.",
  keywords: [
    "NBA Top Shot offers",
    "Top Shot bid vs ask",
    "Top Shot offer spread",
    "Top Shot floor ask",
    "Top Shot liquidity",
    "Top Shot standing offers",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/offer-spread`,
  },
  openGraph: {
    title: "Bid vs Floor — Top Shot Offer/Ask Spread",
    description:
      "Top Shot editions where the top standing offer meets or approaches the floor ask. The bid-vs-floor signal no native surface shows.",
    url: `${SITE_URL}/insights/offer-spread`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/offer-spread`,
        width: 1200,
        height: 630,
        alt: "Bid vs Floor — Top Shot Offer/Ask Spread — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Bid vs Floor — Top Shot Offer/Ask Spread",
    description:
      "Top Shot editions where the top standing offer meets or approaches the floor ask.",
    images: [`${SITE_URL}/api/og/insights/offer-spread`],
    creator: "@RipPacksCity",
  },
}

export default function OfferSpreadLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Bid vs Floor — Top Shot Offer/Ask Spread",
    url: `${SITE_URL}/insights/offer-spread`,
    // ⚠ THIS DESCRIPTION ENDED "Refreshes continuously." and it was the LAST copy of a
    // claim retired everywhere else on 2026-08-29 — the fifth and sixth instances of one
    // sentence, in the two board layouts, found only by fetching the DEPLOYED HTML after
    // the component tests went green. Component tests cannot see a sibling layout, so
    // "the page no longer says it" was true of the page and false of the document.
    // ⛔ It is also the WORST place for it: this is structured data, so the claim is
    // machine-read by search engines rather than merely displayed. On the day it was
    // removed, `offers-sweep` had not confirmed an ask in over 30 hours.
    // The boards now report per-row ask ages; the description says what the board IS.
    description:
      "Ranks NBA Top Shot editions by how tightly the top standing offer meets the floor ask. Every floor ask carries the time we last confirmed it.",
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
