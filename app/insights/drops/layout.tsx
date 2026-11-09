// app/insights/drops/layout.tsx — SEO surface for the public "Pack drops this week" board.
import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const TITLE = "Pack Drops This Week — Top Shot, Pinnacle, Panini & More"
// No computed figure in static metadata: it would go stale between deploys
// (__tests__/board-metadata-carries-no-computed-figure.test.ts). The OG image is live.
const DESCRIPTION =
  "Every pack drop open now or starting this week across NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, Panini and Candy MLB — price, and when pre-orders close or the drop opens, in Pacific Time. Free."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ["NBA Top Shot drop", "Top Shot pre-order", "Rookie Debut drop", "Disney Pinnacle release", "Panini NFT packs", "pack drops this week"].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/drops` },
  openGraph: {
    title: TITLE,
    description: "Every pack drop open now or starting this week, with price and closing times in PT.",
    url: `${SITE_URL}/insights/drops`,
    siteName: "Rip Packs City",
    images: [{ url: `${SITE_URL}/api/og/insights/drops`, width: 1200, height: 630, alt: "Pack drops this week — Rip Packs City" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description: "Every pack drop open now or starting this week, with price and closing times in PT.",
    images: [`${SITE_URL}/api/og/insights/drops`],
    creator: "@RipPacksCity",
  },
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
