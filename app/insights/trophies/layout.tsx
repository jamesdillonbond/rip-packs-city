// app/insights/trophies/layout.tsx
//
// SEO surface for the public Trophy Room. Server component so the metadata
// export is honored (a "use client" page.tsx cannot export metadata directly).
// The canonical is param-stripped (always /insights/trophies) so the
// ?collection= / ?type= / ?sort= filtered URLs don't index as duplicate
// content. Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "The Trophy Room — Rarest Moments on Flow | Rip Packs City",
  description:
    "Every 1-of-1 and Ultimate-tier moment across NBA Top Shot and NFL All Day, ranked by value. The rarest editions on the Flow blockchain, in one place. Free. No signup.",
  keywords: [
    "NBA Top Shot 1 of 1",
    "Top Shot Ultimate moments",
    "rarest Top Shot moments",
    "NFL All Day 1 of 1",
    "Flow blockchain grails",
    "Top Shot trophy moments",
    "Top Shot Supernova Ultimate",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/trophies`,
  },
  openGraph: {
    title: "The Trophy Room — Rarest Moments on Flow",
    description:
      "Every 1-of-1 + Ultimate-tier moment across NBA Top Shot and NFL All Day, ranked by value. The rarest editions on the chain.",
    url: `${SITE_URL}/insights/trophies`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/trophies`,
        width: 1200,
        height: 630,
        alt: "The Trophy Room — Rarest Moments on Flow — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The Trophy Room — Rarest Moments on Flow",
    description:
      "Every 1-of-1 + Ultimate-tier moment across NBA Top Shot and NFL All Day, ranked by value.",
    images: [`${SITE_URL}/api/og/insights/trophies`],
    creator: "@RipPacksCity",
  },
}

export default function TrophiesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "The Trophy Room",
    url: `${SITE_URL}/insights/trophies`,
    description:
      "Ranks the rarest NBA Top Shot and NFL All Day editions — every 1-of-1 and Ultimate-tier moment — by fair market value.",
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
