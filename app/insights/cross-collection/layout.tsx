// app/insights/cross-collection/layout.tsx

import type { Metadata } from "next"
import { TWITTER_INHERITED } from "@/lib/seo"
import { readCrossCollectionCohortSize } from "@/lib/insights/cross-collection-cohort"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

/**
 * ⚠ The cohort size is READ, never baked.
 *
 * These three descriptions used to hardcode "143 wallets" while the board itself
 * rendered the live `stats.cohort_size` from the mat. The cohort is a growing
 * population — 143 at some unknown past date, 179 on 2026-08-17, 220 on
 * 2026-08-26 — so the indexed SEO claim was ~35% low and the page disagreed with
 * its own metadata. Re-baking today's number would be the same defect with a
 * fresher constant.
 *
 * The read lives in `lib/` (not inline here) because non-page server files are
 * held at ZERO inline DB readers by `server-page-data-access-ratchet`, and
 * because `app/**` layouts are measured by neither coverage gate.
 *
 * A `null` count DROPS the number from every string rather than substituting
 * one; see the fetcher for why `?? 0` here would be a published fabrication.
 */
export async function generateMetadata(): Promise<Metadata> {
  const cohort = await readCrossCollectionCohortSize()

  // Two phrasings, and the count-free one is a complete sentence in its own
  // right rather than a degraded stub — a reader (or a crawler) that gets it
  // learns exactly the same thing about the board, minus one number.
  const lead = cohort === null ? "Wallets that hold" : `${cohort.toLocaleString("en-US")} wallets hold`

  return {
    // The root metadata template in lib/seo.ts appends " | Rip Packs City",
    // so baking the brand in here rendered it twice. (deep-audit D24)
    title: "Cross-Collection Whale Map",
    description: `${lead} 3+ Flow blockchain collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. Cohort distribution, top wallets, TS set overlap. Free. No signup.`,
    keywords: [
      "Flow blockchain whales",
      "NBA Top Shot whales",
      "NFL All Day whales",
      "cross-collection collectors",
      "Flow NFT cohort",
    ].join(", "),
    alternates: { canonical: `${SITE_URL}/insights/cross-collection` },
    // ⚠ openGraph and twitter merge SHALLOWLY with the root metadata, so both
    // objects must stay complete here — dropping siteName/locale/type or
    // TWITTER_INHERITED silently removes them from this route.
    openGraph: {
      title: "Cross-Collection Whale Map",
      description: `${lead} 3+ Flow collections. Their cohort distribution + the TS sets they actually collect.`,
      url: `${SITE_URL}/insights/cross-collection`,
      siteName: "Rip Packs City",
      images: [
        {
          url: `${SITE_URL}/api/og/insights/cross-collection`,
          width: 1200,
          height: 630,
          alt: "Cross-Collection Whale Map — Rip Packs City",
        },
      ],
      locale: "en_US",
      type: "website",
    },
    twitter: {
      ...TWITTER_INHERITED,
      card: "summary_large_image",
      title: "Cross-Collection Whale Map",
      description: `${lead} 3+ Flow collections — their cohort, broken down.`,
      images: [`${SITE_URL}/api/og/insights/cross-collection`],
      creator: "@RipPacksCity",
    },
  }
}

export default function CrossCollectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
