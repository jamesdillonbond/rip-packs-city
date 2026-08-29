// app/insights/deals/layout.tsx
//
// SEO surface for the public Below FMV board. Server component so the metadata
// export is honored (a "use client" page.tsx cannot export metadata). Canonical
// is param-stripped so ?player=/?set=/?tier= drill-downs don't index as
// duplicates (QA point 5). Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// NOTE (2026-07-28): every string here named only Top Shot + Pinnacle while
// NFL All Day was the board's LARGEST leg (47% of rows). All three collections
// are named now — keep them in sync with the view's three legs. Internal FMV
// confidence-tier names stay OFF this surface per the standing no-confidence-UI
// policy; describe the bar in plain terms instead.
export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value",
  description:
    "NBA Top Shot, NFL All Day and Disney Pinnacle editions listed below a fair value we can stand behind — the public cross-collection deals board. The top-of-funnel counterpart to the sniper. Free. No signup.",
  keywords: [
    "NBA Top Shot deals",
    "NFL All Day deals",
    "Disney Pinnacle deals",
    "Top Shot below FMV",
    "All Day below FMV",
    "Pinnacle below FMV",
    "underpriced moments",
    "Top Shot fair value",
    "All Day fair value",
    "Pinnacle floor",
    "Top Shot sniper",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/deals`,
  },
  openGraph: {
    title: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value",
    description:
      "Top Shot and NFL All Day asks and Disney Pinnacle floors listed below a fair value we can stand behind. What's underpriced right now — the public deals board.",
    url: `${SITE_URL}/insights/deals`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/deals`,
        width: 1200,
        height: 630,
        alt: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value",
    description:
      "Top Shot and NFL All Day asks and Disney Pinnacle floors listed below a fair value we can stand behind — what's underpriced right now.",
    images: [`${SITE_URL}/api/og/insights/deals`],
    creator: "@RipPacksCity",
  },
}

export default function DealsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value",
    url: `${SITE_URL}/insights/deals`,
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
      "Ranks NBA Top Shot, NFL All Day and Disney Pinnacle editions listed below a fair value priced from recent corroborated sales, by discount. Every ask carries the time we last confirmed it.",
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
