// app/insights/set-squeeze/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Shot Set Squeeze Leaderboard | Rip Packs City",
  description:
    "Top Shot sets ranked by average lock + burn squeeze across their editions. Drill-down companion to the per-edition squeeze board. Set completionists' tightest targets. Free. No signup.",
  keywords: [
    "NBA Top Shot set squeeze",
    "Top Shot set completion",
    "WNBA Squad Goals squeeze",
    "Top Shot challenge sets",
    "set scarcity",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/set-squeeze` },
  openGraph: {
    title: "Top Shot Set Squeeze Leaderboard",
    description:
      "Top Shot sets ranked by average lock + burn across their editions. Set-completionist scarcity view.",
    url: `${SITE_URL}/insights/set-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/set-squeeze`,
        width: 1200,
        height: 630,
        alt: "Top Shot Set Squeeze Leaderboard — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Shot Set Squeeze Leaderboard",
    description:
      "Top Shot sets ranked by lock + burn across editions.",
    images: [`${SITE_URL}/api/og/insights/set-squeeze`],
    creator: "@RipPacksCity",
  },
}

export default function SetSqueezeLayout({ children }: { children: React.ReactNode }) {
  return children
}
