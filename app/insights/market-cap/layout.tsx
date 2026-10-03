// app/insights/market-cap/layout.tsx
//
// SEO surface for the public Market Cap board. Server component so the metadata
// export is honored. The canonical is param-stripped (always /insights/market-cap)
// so a filtered URL doesn't index as duplicate content. Mirrors
// app/insights/set-completers/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const TITLE = "Market Cap — Collections, Players, Teams, Sets and Badges"
const DESCRIPTION =
  "Market cap for NBA Top Shot, NFL All Day, Panini and every Flow collection we price: fair market value times the supply collectors actually hold, with burned Moments and unopened packs taken out. By collection, player, team, set, series, tier and badge. Free. No signup."

export const metadata: Metadata = {
  // The root metadata template appends " | Rip Packs City".
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "NBA Top Shot market cap",
    "Top Shot player market cap",
    "NFL All Day market cap",
    "Top Shot circulating supply",
    "Top Shot burned moments",
    "Flow NFT market cap",
    "digital collectibles market cap",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/market-cap`,
  },
  openGraph: {
    title: TITLE,
    description:
      "FMV x collector-held supply — burned Moments and unopened packs excluded — by collection, player, team, set and badge.",
    url: `${SITE_URL}/insights/market-cap`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/market-cap`,
        width: 1200,
        height: 630,
        alt: "Market Cap — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description:
      "FMV x collector-held supply — burned Moments and unopened packs excluded — by collection, player, team, set and badge.",
    images: [`${SITE_URL}/api/og/insights/market-cap`],
    creator: "@RipPacksCity",
  },
}

export default function MarketCapLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Market Cap — Flow digital collectibles",
    url: `${SITE_URL}/insights/market-cap`,
    description:
      "Market cap for each Flow digital-collectible collection and for its players, teams, sets, series, tiers and badges: fair market value times collector-held supply (minted minus burned minus issuer-held).",
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
