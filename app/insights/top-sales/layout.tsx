// app/insights/top-sales/layout.tsx
//
// SEO surface for the public Top Sales / Whale Watch board. Server component so
// the metadata export is honored (a "use client" page.tsx cannot export
// metadata directly). The canonical is param-stripped (always
// /insights/top-sales) so the ?collection= / ?window= / ?sort= filtered URLs
// don't index as duplicate content. Mirrors app/insights/trophies/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Sales — The Whales of the Week | Rip Packs City",
  description:
    "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one. The freshest board on Flow. Free. No signup.",
  keywords: [
    "NBA Top Shot biggest sales",
    "Top Shot whale watch",
    "Top Shot recent sales",
    "NFL All Day biggest sales",
    "Flow blockchain top sales",
    "Top Shot sales tracker",
    "who bought Top Shot moment",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/top-sales`,
  },
  openGraph: {
    title: "Top Sales — The Whales of the Week",
    description:
      "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one.",
    url: `${SITE_URL}/insights/top-sales`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/top-sales`,
        width: 1200,
        height: 630,
        alt: "Top Sales — The Whales of the Week — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Sales — The Whales of the Week",
    description:
      "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one.",
    images: [`${SITE_URL}/api/og/insights/top-sales`],
    creator: "@RipPacksCity",
  },
}

export default function TopSalesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Top Sales — Whale Watch",
    url: `${SITE_URL}/insights/top-sales`,
    description:
      "Ranks the biggest recent NBA Top Shot and NFL All Day sales, with the buyer and seller resolved to their Top Shot handles.",
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
