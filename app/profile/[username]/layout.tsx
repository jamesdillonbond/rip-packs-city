// Link-preview metadata for /profile/<username>.
//
// This file IS the unfurl. Whatever it emits is what X, Discord, Slack,
// iMessage and every crawler show when a collector shares their profile, so two
// properties matter more than anything else here: it must never state a figure
// it could not read, and it must carry the full card contract (site name, type,
// canonical url, image dimensions, alt text) rather than a partial one.
//
// 2026-08-13 — TWO defects fixed, both invisible from the page itself:
//
// (1) SELF-FETCH. This module reached its data by making a server-side HTTP
//     round trip back to /api/public/profile/<username> with `cache:"no-store"`.
//     That is the exact anti-pattern commit dd13a03e removed from page.tsx —
//     but the guard it shipped with (__tests__/profile-ssr-no-self-fetch)
//     enumerated `page.tsx` by hand, so its sibling was outside the guard BY
//     CONSTRUCTION and kept the hop. Every crawl cost an extra lambda plus
//     uncached DB work on the CRAWLER path, and the unfurl could degrade purely
//     because our own API had been rate limited. It now calls the shared data
//     layer directly, request-memoized so the page shell's identical call is
//     free. The guard now covers this file too.
//
// (2) A FALSE FINANCIAL CLAIM ABOUT A NAMED PERSON. The old catch fell through
//     to `totalFmv = 0 / momentCount = 0`, so ANY failed read published
//     "Portfolio: $0 FMV across 0 moments" as that collector's description —
//     into a social card, about an identifiable individual, indistinguishable
//     from the truth. This is the same class commit 8371cfdf fixed in the OG
//     IMAGE (`walletsOk ? fmtDollars(total) : "—"`); the description text was
//     left behind because the two live in different files. Three states now,
//     not two: read failed (withhold every figure), read succeeded with nothing
//     to report (describe the profile, claim no number), and real totals.
//
// ⚠ Next merges `openGraph` and `twitter` SHALLOWLY — a route that defines
// either one REPLACES the root object wholesale rather than extending it. The
// previous version defined both, which silently dropped `siteName`, `type`,
// `locale` and `twitter.creator` from lib/seo.ts on every profile unfurl. Any
// field this file wants on the card has to be restated here; do not assume the
// root defaults survive.

import type { Metadata } from "next"
import { getPublicProfile } from "@/lib/profile/public-profile"

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K"
  return "$" + Math.round(n).toLocaleString()
}

/**
 * The one-line description under the card image.
 *
 * INVARIANT: this function never emits a zero. Every figure is gated on being
 * positive, so a total that is absent — whether because the collector has no
 * linked wallet or because we could not read the row — falls out of the string
 * entirely rather than being published as "$0". That is what makes the two
 * cases safe to collapse: they produce identical copy, so the caller does not
 * have to get the failure branch right for the output to stay honest.
 *
 * ⚠ It deliberately takes NO `ok` flag. An earlier draft passed one, and it
 * could not change a single character of the output — on a failed read the
 * caller has no data, so every total is already zero and already suppressed. A
 * parameter that reads as a safety property while being incapable of altering
 * behaviour is worse than none: no mutation can red it, so it documents a
 * guarantee the tests cannot hold. The honesty rule lives in the `> 0` guards,
 * where it is provable. (`ok` still matters in the caller, but for `robots` —
 * a 404 must not be indexed, a transient 500 must not be de-indexed.)
 *
 * It also never says "unavailable". Platforms cache an unfurl for days, so a
 * momentary outage would otherwise pin an outage notice to the collector's
 * profile long after it recovered — the OG-card lesson in lib/og/board-empty-copy.
 */
export function profileDescription(input: {
  totalFmv: number
  momentCount: number
  trophyCount: number
}): string {
  const { totalFmv, momentCount, trophyCount } = input
  const parts: string[] = []

  if (totalFmv > 0) parts.push(fmtDollars(totalFmv) + " portfolio")
  if (momentCount > 0)
    parts.push(momentCount.toLocaleString() + " Moment" + (momentCount === 1 ? "" : "s"))
  if (trophyCount > 0)
    parts.push(trophyCount + " trophy Moment" + (trophyCount === 1 ? "" : "s") + " on display")

  if (parts.length === 0) {
    return "Trophy case, collection breakdown and portfolio analytics on Rip Packs City."
  }
  return parts.join(" · ") + " — tracked on Rip Packs City."
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>
}): Promise<Metadata> {
  const { username } = await params
  const key = decodeURIComponent(username ?? "").trim()

  // Same `source` label the page shell passes, so the two share one memoized
  // read instead of running the fan-out twice per request.
  const result = key
    ? await getPublicProfile(key, "ssr").catch(() => null)
    : null

  // A 404 is a real answer, not a failed read — but it is also not a profile,
  // so it must not be indexed as one. Only a 500 (or a thrown error) withholds
  // the figures; a resolved profile with nothing in it reports honestly.
  const resolved = result?.ok === true ? result.data : null
  const notFound = result?.ok === false && result.status === 404

  const displayName = resolved?.bio?.display_name?.trim() || key || "Collector"

  let totalFmv = 0
  let momentCount = 0
  for (const w of resolved?.wallets ?? []) {
    // Headline excludes the stale-priced portion, as the dashboard's does
    // (2026-09-02, QA finding #6) — the meta description is what X shows
    // under the card, so it must be the same number as the page.
    totalFmv += (Number(w?.cached_fmv ?? 0) || 0) - (Number(w?.cached_fmv_stale ?? 0) || 0)
    momentCount += Number(w?.cached_moment_count ?? 0) || 0
  }
  if (totalFmv < 0) totalFmv = 0
  const trophyCount = resolved?.trophies?.length ?? 0

  const canonical = `${BASE_URL}/profile/${encodeURIComponent(key)}`
  const ogUrl = `${BASE_URL}/api/og/profile/${encodeURIComponent(key)}`
  const title = `${displayName}'s Collection | Rip Packs City`
  const description = profileDescription({ totalFmv, momentCount, trophyCount })

  // Describes what is IN the card, for screen readers and for the platforms
  // that surface alt text. Deliberately free of figures — the image withholds
  // them on a failed read and this string is built before we know whether the
  // card's own reads succeeded.
  const imageAlt = `${displayName}'s trophy case and collection on Rip Packs City`

  return {
    // `absolute` skips the site-wide "%s | Rip Packs City" template
    // (lib/seo.ts) so the suffix isn't appended twice.
    title: { absolute: title },
    description,
    alternates: { canonical },
    // A username that resolves to nothing still renders a page shell; it must
    // not enter the index as if it were a real collector.
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

export default function PublicProfileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
