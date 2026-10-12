// app/insights/panini-premiums/layout.tsx
//
// SEO surface for the Panini premiums board (2026-10-10). Server component so the metadata export
// is honoured. Canonical is param-stripped. The share image is the text-only default board
// card (/api/og/insights/panini-premiums). Gated like every /insights/panini* surface: proxy.ts 302s it while
// PANINI_PUBLIC is false, and `robots` drops to noindex on the same flag. Title uses `absolute`
// (the root template would otherwise append the brand twice).

import type { Metadata } from "next"
import { PANINI_PUBLIC } from "@/lib/launch-flags"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const TITLE = "Panini Premiums — What Parallels and #1 Serials Really Sell For"
const DESCRIPTION =
  "Panini digital cards across soccer, NBA, NFL, WNBA, MLB and NASCAR: what each numbered parallel's FMV commands over the player's common base, and what #1 and perfect-mint serials actually sold for against their edition's typical sale. Free. No signup."
// 2026-10-11: the text-only default board card (app/api/og/insights/[slug]) — this
// used to borrow Panini's COLLECTION card, so a share of the board previewed as the collection.
const OG_IMAGE = `${SITE_URL}/api/og/insights/panini-premiums`

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Rip Packs City` },
  description: DESCRIPTION,
  keywords: [
    "Panini NFT parallel value",
    "Panini Prizm parallel premium",
    "Panini NFT #1 serial price",
    "Panini digital card values",
    "Panini Blockchain cards",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/panini-premiums` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/insights/panini-premiums`,
    siteName: "Rip Packs City",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: `${TITLE} — Rip Packs City` }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
  ...(PANINI_PUBLIC ? {} : { robots: { index: false, follow: false } }),
}

export default function PaniniPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("panini-premiums")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {children}
    </>
  )
}
