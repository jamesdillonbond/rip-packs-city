// app/insights/market-pulse/layout.tsx — SEO surface for the public Market Pulse board.
import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Market Pulse — Digital Collectibles Volume, Buyers & Sellers",
  description:
    "Live secondary-market health for every collection we track — NBA Top Shot, Panini, Disney Pinnacle, NFL All Day, LaLiga Golazos, UFC Strike and Candy MLB — volume, sales, buyers and sellers across 24h, 7d and 30d, in one view. Free.",
  keywords: [
    "NBA Top Shot volume",
    "Top Shot market stats",
    "Flow collectibles volume",
    "NFL All Day sales volume",
    "Disney Pinnacle market",
    "Top Shot buyers sellers",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/market-pulse` },
  openGraph: {
    title: "Market Pulse — Digital Collectibles Volume, Buyers & Sellers",
    description: "Every collection's secondary-market health in one view — volume, buyers, sellers across 24h/7d/30d.",
    url: `${SITE_URL}/insights/market-pulse`,
    siteName: "Rip Packs City",
    images: [{ url: `${SITE_URL}/api/og/insights/market-pulse`, width: 1200, height: 630, alt: "Market Pulse — Rip Packs City" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Market Pulse — Digital Collectibles Volume, Buyers & Sellers",
    description: "Every collection's secondary-market health in one view.",
    images: [`${SITE_URL}/api/og/insights/market-pulse`],
    creator: "@RipPacksCity",
  },
}

export default function MarketPulseLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("market-pulse")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
