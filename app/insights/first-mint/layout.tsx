// app/insights/first-mint/layout.tsx
//
// SEO surface for the public Top Shot first-mint trophy tracker.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Shot First-Mint Trophy Tracker | Rip Packs City",
  description:
    "Every Top Shot serial #1 sale of the last 90 days, with the multiplier vs the average serial price of the same edition. Trophies aren't a vibe — they're math.",
  keywords: [
    "NBA Top Shot serial 1",
    "Top Shot first mint",
    "Top Shot trophies",
    "Jokic Base Set #1",
    "NBA Top Shot rare serials",
    "Top Shot trophy market",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/first-mint`,
  },
  openGraph: {
    title: "Top Shot First-Mint Trophy Tracker",
    description:
      "Every TS serial #1 sale of the last 90 days, with the multiplier vs avg serial. Average: 15.8×. Max: 248×.",
    url: `${SITE_URL}/insights/first-mint`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/first-mint`,
        width: 1200,
        height: 630,
        alt: "Top Shot First-Mint Trophy Tracker — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Shot First-Mint Trophy Tracker",
    description:
      "Trophies aren't a vibe — they're math. Every serial #1 sale, last 90d.",
    images: [`${SITE_URL}/api/og/insights/first-mint`],
    creator: "@RipPacksCity",
  },
}

export default function FirstMintLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Top Shot First-Mint Trophy Tracker",
    url: `${SITE_URL}/insights/first-mint`,
    description:
      "Quantifies the first-mint trophy thesis on NBA Top Shot — every serial #1 sale of the last 90 days with the multiplier vs the average-serial price. Refreshes hourly.",
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
