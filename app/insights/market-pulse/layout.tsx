// app/insights/market-pulse/layout.tsx — SEO surface for the public Market Pulse board.
import type { Metadata } from "next"
import { TWITTER_INHERITED } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Market Pulse — Flow Collectibles Volume, Buyers & Sellers",
  description:
    "Live secondary-market health for every Flow collection — NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, UFC Strike — volume, sales, buyers and sellers across 24h, 7d and 30d. All five leagues in one view. Free.",
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
    title: "Market Pulse — Flow Collectibles Volume, Buyers & Sellers",
    description: "Every Flow collection's secondary-market health in one view — volume, buyers, sellers across 24h/7d/30d.",
    url: `${SITE_URL}/insights/market-pulse`,
    siteName: "Rip Packs City",
    images: [{ url: `${SITE_URL}/api/og/insights/market-pulse`, width: 1200, height: 630, alt: "Market Pulse — Rip Packs City" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Market Pulse — Flow Collectibles Volume, Buyers & Sellers",
    description: "Every Flow collection's secondary-market health in one view.",
    images: [`${SITE_URL}/api/og/insights/market-pulse`],
    creator: "@RipPacksCity",
  },
}

export default function MarketPulseLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Market Pulse",
    url: `${SITE_URL}/insights/market-pulse`,
    description: "Per-collection Flow secondary-market volume, sales, buyers and sellers across 24h/7d/30d.",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "Rip Packs City", url: SITE_URL },
  }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  )
}
