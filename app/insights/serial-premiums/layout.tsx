// app/insights/serial-premiums/layout.tsx
//
// SEO surface for the public Serial Premiums (#1 Watch) board. Server component
// so the metadata export is honored (a "use client" page.tsx cannot export
// metadata directly). The canonical is param-stripped (always
// /insights/serial-premiums) so the ?tier= / ?window= / ?sort= filtered URLs
// don't index as duplicate content. Mirrors app/insights/top-sales/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Serial Premiums — What the #1 Mint Really Sells For | Rip Packs City",
  description:
    "The most extreme #1-mint premiums on NBA Top Shot — what collectors actually paid for the #1 serial vs the edition's typical price. Every row a real sale. Free. No signup.",
  keywords: [
    "Top Shot #1 mint premium",
    "NBA Top Shot serial number 1 sales",
    "Top Shot low serial premium",
    "Top Shot jersey mint value",
    "what is a #1 mint worth Top Shot",
    "Top Shot serial premium tracker",
    "Flow blockchain serial premiums",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/serial-premiums`,
  },
  openGraph: {
    title: "Serial Premiums — What the #1 Mint Really Sells For",
    description:
      "The most extreme #1-mint premiums on NBA Top Shot — what the #1 serial actually sold for vs the edition's typical price.",
    url: `${SITE_URL}/insights/serial-premiums`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/serial-premiums`,
        width: 1200,
        height: 630,
        alt: "Serial Premiums — What the #1 Mint Really Sells For — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Serial Premiums — What the #1 Mint Really Sells For",
    description:
      "The most extreme #1-mint premiums on NBA Top Shot — every row a real sale, not an estimate.",
    images: [`${SITE_URL}/api/og/insights/serial-premiums`],
    creator: "@RipPacksCity",
  },
}

export default function SerialPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Serial Premiums — #1 Watch",
    url: `${SITE_URL}/insights/serial-premiums`,
    description:
      "Ranks NBA Top Shot editions by how much more the #1 serial sold for than the edition's typical price, using real on-chain sales.",
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
