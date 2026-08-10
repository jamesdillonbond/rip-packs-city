// app/insights/parallel-premiums/layout.tsx
//
// SEO surface for the public Parallel Premiums board. Server component so the
// metadata export is honored. Canonical is param-stripped so ?parallel= / ?sort=
// filtered URLs don't index as duplicates. Mirrors serial-premiums/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Parallel Premiums — What Each Top Shot Parallel Is Really Worth",
  description:
    "Every NBA Top Shot parallel (Hexwave, Cosmic, Club Collection, Jukebox…) priced against its Standard base — the exact premium each subedition commands. Intelligence Top Shot and dapper.market don't have. Free, no signup.",
  keywords: [
    "Top Shot parallel value",
    "NBA Top Shot Hexwave price",
    "Top Shot subedition premium",
    "Top Shot Cosmic parallel worth",
    "Top Shot Club Collection value",
    "Top Shot parallel vs standard",
    "Flow blockchain parallel premiums",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/parallel-premiums` },
  openGraph: {
    title: "Parallel Premiums — What Each Top Shot Parallel Is Really Worth",
    description:
      "Every Top Shot parallel priced against its Standard base — the exact premium each subedition commands. The intelligence Top Shot and dapper.market don't show.",
    url: `${SITE_URL}/insights/parallel-premiums`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/parallel-premiums`,
        width: 1200,
        height: 630,
        alt: "Parallel Premiums — What Each Top Shot Parallel Is Really Worth — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Parallel Premiums — What Each Top Shot Parallel Is Really Worth",
    description:
      "Every Top Shot parallel priced against its Standard base. Intelligence Top Shot and dapper.market don't have.",
    images: [`${SITE_URL}/api/og/insights/parallel-premiums`],
    creator: "@RipPacksCity",
  },
}

export default function ParallelPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Parallel Premiums",
    url: `${SITE_URL}/insights/parallel-premiums`,
    description:
      "Ranks NBA Top Shot parallel (subedition) editions by the premium their FMV commands over the Standard base edition of the same play.",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "Rip Packs City", url: SITE_URL },
  }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  )
}
