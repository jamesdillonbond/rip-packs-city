// Link-preview metadata for /profile/<username>/trophy-case.
//
// The shareable trophy case. The profile card answers "how big is this
// collection" (it leads with portfolio FMV); this one answers "look at these
// six", so it gets its own card and its own copy rather than reusing the
// profile's. Until 2026-08-14 the only trophy-case export was a PDF, which
// cannot unfurl at all — pasting one into X or Discord produces a file, not a
// picture.
//
// ⚠ Same two rules as the profile unfurl, for the same reasons: NEVER publish a
// figure the read did not produce, and restate every root openGraph/twitter
// field, because Next REPLACES those objects when a route redefines them rather
// than merging (so siteName / type / locale / creator from lib/seo.ts do not
// survive otherwise).

import type { Metadata } from "next"
import { getPublicProfile } from "@/lib/profile/public-profile"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

/**
 * The line under the card.
 *
 * INVARIANT, same as `profileDescription`: it never emits a zero. A count we
 * could not read falls out of the sentence rather than being published as "0
 * trophy Moments", which reads as an empty case rather than as an absent read.
 */
export function trophyCaseDescription(input: {
  displayName: string
  trophyCount: number
}): string {
  const { displayName, trophyCount } = input
  if (trophyCount > 0) {
    return `${trophyCount} trophy Moment${trophyCount === 1 ? "" : "s"} hand-picked by ${displayName} — the case they chose to show off, on Rip Packs City.`
  }
  return `${displayName}'s trophy case on Rip Packs City — six slots for the Moments that mean the most.`
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>
}): Promise<Metadata> {
  const { username } = await params
  const key = decodeURIComponent(username ?? "").trim()

  // Same `source` label as the page shell so the two share one memoized read.
  const result = key ? await getPublicProfile(key, "ssr").catch(() => null) : null
  const resolved = result?.ok === true ? result.data : null
  const notFound = result?.ok === false && result.status === 404

  const displayName = resolved?.bio?.display_name?.trim() || key || "Collector"
  const trophyCount = resolved?.trophies?.length ?? 0

  const canonical = `${BASE_URL}/profile/${encodeURIComponent(key)}/trophy-case`
  const ogUrl = `${BASE_URL}/api/og/trophy-case/${encodeURIComponent(key)}`
  const title = `${displayName}'s Trophy Case | Rip Packs City`
  const description = trophyCaseDescription({ displayName, trophyCount })
  const imageAlt = `${displayName}'s trophy case on Rip Packs City`

  return {
    title: { absolute: title },
    description,
    alternates: { canonical },
    ...(notFound ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "profile",
      locale: "en_US",
      siteName: "Rip Packs City",
      url: canonical,
      title,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630, alt: imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@RipPacksCity",
      creator: "@RipPacksCity",
      title,
      description,
      images: [{ url: ogUrl, alt: imageAlt }],
    },
  }
}

export default function TrophyCaseLayout({ children }: { children: React.ReactNode }) {
  return children
}
