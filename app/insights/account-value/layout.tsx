// app/insights/account-value/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "What's My NBA Top Shot Account Worth? Free Portfolio Value | Rip Packs City",
  description:
    "Paste your Top Shot username or Flow wallet and see your account's total value — live FMV across every moment you own. Free, no signup. Works for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike.",
  keywords: [
    "nba top shot account value",
    "what's my top shot account worth",
    "top shot portfolio value",
    "top shot collection value",
    "nfl all day account value",
    "flow collectibles portfolio value",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/account-value` },
  openGraph: {
    title: "What's My Account Worth? — Free Portfolio Value",
    description:
      "Paste your wallet, see your Flow collectibles account's total value — live FMV across every moment. Free, no signup.",
    url: `${SITE_URL}/insights/account-value`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights`,
        width: 1200,
        height: 630,
        alt: "What's My Account Worth? — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "What's My Account Worth?",
    description: "See your Flow collectibles account's total value — live FMV, free.",
    images: [`${SITE_URL}/api/og/insights`],
    creator: "@RipPacksCity",
  },
}

export default function AccountValueLayout({ children }: { children: React.ReactNode }) {
  return children
}
