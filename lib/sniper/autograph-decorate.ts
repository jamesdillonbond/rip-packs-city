// lib/sniper/autograph-decorate.ts
//
// Marks signed editions on a built Sniper board (NBA Top Shot, NFL All Day) and
// applies the "Autographs only" filter. Source of truth: editions.autographed_at
// via lib/autographs.ts.
//
// ⚠ A failed autograph read is NOT "nothing here is signed". The decoration then
// adds nothing (deals keep their other badges), `autographsRead` is false, and
// with "Autographs only" on the caller must report the board as degraded rather
// than render an empty list as if no signed Moment were listed.

import {
  AUTOGRAPH_BADGE_SLUG,
  allDayPairKey,
  fetchAllDayAutographedPairs,
  fetchTopShotAutographedKeys,
  withAutographSlug,
} from "@/lib/autographs"
import { BADGE_LABELS } from "@/lib/sniper/feed-helpers"

export type AutographDecoratable = {
  editionKey: string
  intEditionKey: string | null
  playerName: string
  setName: string
  hasBadge: boolean
  badgeSlugs: string[]
  badgeLabels: string[]
  isAutographed?: boolean
}

export type AutographCollection = "nba-top-shot" | "nfl-all-day"

export function isAutographCollection(c: string): c is AutographCollection {
  return c === "nba-top-shot" || c === "nfl-all-day"
}

/** Pure: mark each deal signed or not from an already-read key set. */
export function markAutographs<T extends AutographDecoratable>(
  deals: readonly T[],
  collection: AutographCollection,
  signedKeys: ReadonlySet<string>,
): T[] {
  return deals.map((d) => {
    const signed =
      collection === "nba-top-shot"
        ? (!!d.editionKey && signedKeys.has(d.editionKey)) ||
          (!!d.intEditionKey && signedKeys.has(d.intEditionKey))
        : signedKeys.has(allDayPairKey(d.playerName, d.setName))
    if (!signed) return { ...d, isAutographed: false }
    const badgeSlugs = withAutographSlug(d.badgeSlugs, true)
    return {
      ...d,
      isAutographed: true,
      hasBadge: true,
      badgeSlugs,
      badgeLabels: badgeSlugs.map((s) => BADGE_LABELS[s] ?? s),
    }
  })
}

export async function decorateAutographs<T extends AutographDecoratable>(
  supa: { from: (table: string) => any },
  collection: AutographCollection,
  deals: readonly T[],
): Promise<{ deals: T[]; autographsRead: boolean }> {
  const read =
    collection === "nba-top-shot"
      ? await fetchTopShotAutographedKeys(supa, "sniper-feed/autographs")
      : await fetchAllDayAutographedPairs(supa, "sniper-feed/autographs")
  if (!read.ok) {
    console.error(`[sniper-feed] autograph read failed (${collection}): ${read.error}`)
    return { deals: [...deals], autographsRead: false }
  }
  return { deals: markAutographs(deals, collection, read.value), autographsRead: true }
}

/** "Autographs only": keep signed deals. */
export function filterAutographsOnly<T extends { isAutographed?: boolean; badgeSlugs: readonly string[] }>(
  deals: readonly T[],
): T[] {
  return deals.filter((d) => d.isAutographed === true || d.badgeSlugs.includes(AUTOGRAPH_BADGE_SLUG))
}
