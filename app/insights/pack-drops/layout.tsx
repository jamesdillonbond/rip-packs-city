// app/insights/pack-drops/layout.tsx
//
// SEO surface for the public Pack Drops board. Server component so the metadata
// export is honored (a "use client" page.tsx can't export metadata). The
// canonical is param-stripped (always /insights/pack-drops). Mirrors
// app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Pack Drops — Is This Re-Pack Worth It? | Rip Packs City",
  description:
    "Vaultopolis re-pack drops of real NBA Top Shot moments, scored against RPC FMV. RPC pool, pack EV vs the FLOW price, value concentration, and odds — the 'is this worth it?' read no marketplace ships. Free. No signup.",
  keywords: [
    "Vaultopolis pack drops",
    "Top Shot re-pack value",
    "Top Shot pack EV",
    "is this Top Shot pack worth it",
    "Vaultopolis drop FMV",
    "NBA Top Shot pack expected value",
    "Flow blockchain re-pack intelligence",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/pack-drops`,
  },
  openGraph: {
    title: "Pack Drops — Is This Re-Pack Worth It?",
    description:
      "Vaultopolis re-pack drops scored against RPC FMV — RPC pool, pack EV vs the FLOW price, value concentration, and odds.",
    url: `${SITE_URL}/insights/pack-drops`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pack-drops`,
        width: 1200,
        height: 630,
        alt: "Pack Drops — Is This Re-Pack Worth It? — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pack Drops — Is This Re-Pack Worth It?",
    description:
      "Vaultopolis re-pack drops scored against RPC FMV. Pack EV vs the FLOW price. Free, no signup.",
    images: [`${SITE_URL}/api/og/insights/pack-drops`],
    creator: "@RipPacksCity",
  },
}

export default function PackDropsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Pack Drops — Re-Pack Value Scanner",
    url: `${SITE_URL}/insights/pack-drops`,
    description:
      "Scores Vaultopolis re-pack drops of real NBA Top Shot moments against RPC FMV — RPC pool, pack expected value vs the FLOW listing price, value concentration, and published odds.",
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
