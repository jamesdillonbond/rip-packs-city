// app/insights/squeeze-check/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "What's Liquid In Your Bag? | Rip Packs City",
  description:
    "Paste your Flow wallet and see how much of your Top Shot collection is actually liquid vs how much is sitting in challenge-locked or burned editions. Free. No signup.",
  keywords: [
    "NBA Top Shot wallet check",
    "Top Shot squeeze exposure",
    "Top Shot collection liquidity",
    "Flow wallet analysis",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/squeeze-check` },
  openGraph: {
    title: "What's Liquid In Your Bag?",
    description:
      "Paste your wallet, see how much of your Top Shot bag is actually liquid vs sitting in lock + burn.",
    url: `${SITE_URL}/insights/squeeze-check`,
    siteName: "Rip Packs City",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "What's Liquid In Your Bag?",
    description:
      "Paste your Flow wallet, see your Top Shot lock + burn exposure.",
    creator: "@RipPacksCity",
  },
}

export default function SqueezeCheckLayout({ children }: { children: React.ReactNode }) {
  return children
}
