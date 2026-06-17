// app/insights/underpriced-serials/layout.tsx
//
// SEO surface for the public Underpriced #1s & Perfect Mints board. Server
// component so the metadata export is honored (a "use client" page.tsx cannot
// export metadata directly). The canonical is param-stripped (always
// /insights/underpriced-serials) so the ?headline= / ?tier= / ?quality= /
// ?sort= filtered URLs don't index as duplicate content. Mirrors
// app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Underpriced #1s — Headline Serials Listed Below Value | Rip Packs City",
  description:
    "NBA Top Shot #1 mints and perfect mints (#N/N) that are LISTED RIGHT NOW for less than the serial is worth. Live deals, ranked by discount. Free. No signup.",
  keywords: [
    "Top Shot underpriced moments",
    "Top Shot #1 mint deals",
    "Top Shot perfect mint for sale",
    "NBA Top Shot serial number 1 listing",
    "cheap Top Shot low serial",
    "Top Shot deal finder",
    "Flow blockchain underpriced serials",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/underpriced-serials`,
  },
  openGraph: {
    title: "Underpriced #1s — Headline Serials Listed Below Value",
    description:
      "NBA Top Shot #1 mints and perfect mints listed right now below their serial-FMV estimate. Live deals, ranked by discount.",
    url: `${SITE_URL}/insights/underpriced-serials`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/underpriced-serials`,
        width: 1200,
        height: 630,
        alt: "Underpriced #1s — Headline Serials Listed Below Value — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Underpriced #1s — Headline Serials Listed Below Value",
    description:
      "Top Shot #1 mints & perfect mints listed below value right now — live deals, ranked by discount.",
    images: [`${SITE_URL}/api/og/insights/underpriced-serials`],
    creator: "@RipPacksCity",
  },
}

export default function UnderpricedSerialsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Underpriced #1s & Perfect Mints",
    url: `${SITE_URL}/insights/underpriced-serials`,
    description:
      "Lists NBA Top Shot headline serials (#1 mint and perfect mint) that are currently listed below their serial-FMV estimate, ranked by discount.",
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
