// app/insights/drops/layout.tsx — SEO surface for the public "Pack drops this week" board.
import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"
import { ogCardDayKey } from "@/lib/og/card-day-key"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const TITLE = "Pack Drops This Week — Top Shot, Pinnacle, Panini & More"
// No computed figure in static metadata: it would go stale between deploys
// (__tests__/board-metadata-carries-no-computed-figure.test.ts). The OG image is live.
const DESCRIPTION =
  "Every pack drop open now or starting this week across NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, Panini and Candy MLB — price, and when pre-orders close or the drop opens, in Pacific Time. Free."

// The OG IMAGE URL carries today's PT date (2026-11-15). X caches a card by its IMAGE URL as well as
// the page URL: the 11-15 2/2 reply with ?w=1115 on the page link still unfurled LAST week's card
// (Rookie Debut Case, Villains Vol.2 …), because og:image was the same bare URL X had cached on 11-08.
// A per-day ?d= makes each day's card a new image to X; the route ignores the param (lib/og/card-day-key.ts).
export function generateMetadata(): Metadata {
  const ogImage = `${SITE_URL}/api/og/insights/drops?d=${ogCardDayKey()}`
  return {
    title: TITLE,
    description: DESCRIPTION,
    keywords: ["NBA Top Shot drop", "Top Shot pre-order", "Rookie Debut drop", "Disney Pinnacle release", "Panini NFT packs", "pack drops this week"].join(", "),
    alternates: { canonical: `${SITE_URL}/insights/drops` },
    openGraph: {
      title: TITLE,
      description: "Every pack drop open now or starting this week, with price and closing times in PT.",
      url: `${SITE_URL}/insights/drops`,
      siteName: "Rip Packs City",
      images: [{ url: ogImage, width: 1200, height: 630, alt: "Pack drops this week — Rip Packs City" }],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      ...TWITTER_INHERITED,
      card: "summary_large_image",
      title: TITLE,
      description: "Every pack drop open now or starting this week, with price and closing times in PT.",
      images: [ogImage],
      creator: "@RipPacksCity",
    },
  }
}

export default function DropsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("drops")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
