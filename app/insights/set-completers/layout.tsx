// app/insights/set-completers/layout.tsx
//
// SEO surface for the public Set Completers board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// The canonical is param-stripped (always /insights/set-completers) so any
// ?sort= filtered URL doesn't index as duplicate content. Mirrors
// app/insights/new-collectors/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Set Completers — Who's Completed the 2025 Rookie Sets",
  description:
    "How many collectors have actually completed each 2025 NBA Top Shot rookie set — base-play completion from the indexed on-chain ownership graph. Completers, holders, and completion rate per set. Free. No signup.",
  keywords: [
    "NBA Top Shot set completers",
    "Top Shot set completion",
    "Top Shot rookie sets",
    "Top Shot Rookie Debut completion",
    "Top Shot ownership",
    "Flow blockchain collectors",
    "Top Shot set collection tracker",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/set-completers`,
  },
  openGraph: {
    title: "Set Completers — Who's Completed the 2025 Rookie Sets",
    description:
      "Completers, holders, and completion rate for each 2025 Top Shot rookie set, from the indexed on-chain ownership graph.",
    url: `${SITE_URL}/insights/set-completers`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/set-completers`,
        width: 1200,
        height: 630,
        alt: "Set Completers — 2025 Rookie Sets — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Set Completers — Who's Completed the 2025 Rookie Sets",
    description:
      "Base-play completion for each 2025 Top Shot rookie set, from the indexed on-chain ownership graph.",
    images: [`${SITE_URL}/api/og/insights/set-completers`],
    creator: "@RipPacksCity",
  },
}

export default function SetCompletersLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Set Completers — 2025 Rookie Set Completion",
    url: `${SITE_URL}/insights/set-completers`,
    description:
      "Tracks how many collectors have completed each 2025 NBA Top Shot rookie set (base-play completion) from the indexed on-chain ownership graph — completers, holders, and completion rate per set.",
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
