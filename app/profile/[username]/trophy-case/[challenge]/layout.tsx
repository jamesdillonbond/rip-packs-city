// Link-preview metadata for /profile/<username>/trophy-case/<challenge>.
//
// Its OWN card (/api/og/trophy-case/<u>?case=<slug>) and copy, so a pasted
// Dame Time link unfurls as that collector's Dame Time pieces — not their main
// case and not their profile. ⚠ Restates every openGraph/twitter field: Next
// REPLACES those objects per route (the parent trophy-case layout's would
// otherwise describe the MAIN case).

import type { Metadata } from "next"
import { getPublicProfile } from "@/lib/profile/public-profile"
import { getPublicChallengeCase } from "@/lib/trophy/public-challenge-case"
import { challengeCaseOgPath, challengeCaseSharePath, isChallengeSlug } from "@/lib/trophy/challenge-link"
import { challengeCaseDescription, titleFromSlug } from "./shared"
import { pinsToken } from "@/lib/og/card-url"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string; challenge: string }>
}): Promise<Metadata> {
  const { username, challenge } = await params
  const key = decodeURIComponent(username ?? "").trim()
  const slug = decodeURIComponent(challenge ?? "").trim().toLowerCase()
  const notFoundMeta: Metadata = {
    title: { absolute: "Trophy case not found | Rip Packs City" },
    description: "There is no such trophy challenge entry on Rip Packs City.",
    robots: { index: false, follow: true },
  }
  if (!key || !isChallengeSlug(slug)) return notFoundMeta

  // Same `source` label / args as the page so the memoized reads are shared.
  const [profile, entryRead] = await Promise.all([
    getPublicProfile(key, "ssr").catch(() => null),
    getPublicChallengeCase(key, slug),
  ])
  if (profile?.ok === false && profile.status === 404) return notFoundMeta
  if (entryRead.ok && entryRead.entry === null) return notFoundMeta

  const entry = entryRead.ok ? entryRead.entry : null
  const displayName = (profile?.ok ? profile.data.bio?.display_name?.trim() : "") || key
  const title = entry?.challenge.title ?? titleFromSlug(slug)
  const filled = entry ? entry.slabs.length : null

  const canonical = `${BASE_URL}${challengeCaseSharePath(key, slug)}`
  const ogUrl = `${BASE_URL}${challengeCaseOgPath(key, slug, entry ? pinsToken(entry.slabs) : null)}`
  const pageTitle = `${displayName}'s ${title} Trophy Case | Rip Packs City`
  const description = challengeCaseDescription({ displayName, title, filled })
  const imageAlt = `${displayName}'s ${title} trophy case on Rip Packs City`

  return {
    title: { absolute: pageTitle },
    description,
    alternates: { canonical },
    openGraph: {
      type: "profile",
      locale: "en_US",
      siteName: "Rip Packs City",
      url: canonical,
      title: pageTitle,
      description,
      images: [{ url: ogUrl, width: 1200, height: 630, alt: imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@RipPacksCity",
      creator: "@RipPacksCity",
      title: pageTitle,
      description,
      images: [{ url: ogUrl, alt: imageAlt }],
    },
  }
}

export default function ChallengeCaseLayout({ children }: { children: React.ReactNode }) {
  return children
}
