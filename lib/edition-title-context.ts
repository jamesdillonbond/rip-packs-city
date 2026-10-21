// lib/edition-title-context.ts
//
// What tells ONE edition apart from the player's other editions in the same
// set — the part of an edition page's <title> and Product name after
// "<player> — ".
//
// ── THE CASE (2026-10-21, SEO pass) ────────────────────────────────────────
// The title was "<player> — <set>". A player has many plays per set, and every
// Top Shot ::N parallel repeated its base edition's title, so measured on live
// data 10,308 of 14,528 Top Shot edition pages (71 %), 2,543 of 6,190 All Day
// (41 %) and 188 of 575 Golazos shared their title with another edition — five
// different Kon Knueppel Signature Series 1/1s read identically. Google folds
// pages it reads as duplicates.
//
// The rule, each part only when present:
//   set · parallel · play · game date · /circulation
//   - parallel: Top Shot's subedition name on a ::N page; else the badge-named
//     parallel (Candy Rainbow, lib/edition-parallel.ts).
//   - play + date: Top Shot, All Day, Golazos (the collections that carry them).
//     play = play_category, falling back to play_type.
//   - /circulation: All Day + Golazos only — there the same play is issued at
//     several tiers (Legendary /30, Rare /300) and one game can yield two plays
//     of one type, which only the mint size separates.
// Measured with this exact rule: duplicate-title pages 10,308 → 82 (Top Shot),
// 2,543 → 50 (All Day), 188 → 88 (Golazos). get_edition_detail carries the
// fields since 20261021142334; absent fields drop out, so an older payload
// renders exactly the old "<set>" context.

import { parallelLabelFromBadges } from "@/lib/edition-parallel"

type Payload = Record<string, unknown>

const PLAY_COLLECTIONS = new Set(["nba-top-shot", "nfl-all-day", "laliga-golazos"])
const CIRCULATION_COLLECTIONS = new Set(["nfl-all-day", "laliga-golazos"])
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function str(p: Payload, k: string): string | null {
  const v = p[k]
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** "2026-02-20" → "Feb 20, 2026". Date-only, parsed by parts — never through a
 *  Date object, which would shift it a day in any zone west of UTC. */
export function formatGameDate(v: unknown): string | null {
  if (typeof v !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return null
  return `${month} ${Number(m[3])}, ${m[1]}`
}

/** The parallel this edition page IS, or null. */
export function editionParallelName(p: Payload, collectionUrlSlug: string): string | null {
  const route = str(p, "route_slug") ?? str(p, "external_id") ?? ""
  if (collectionUrlSlug === "nba-top-shot" && route.includes("::")) {
    const sub = str(p, "subedition_name")
    if (sub) return sub
  }
  const badges = Array.isArray(p.badges) ? (p.badges as unknown[]).map((b) => (typeof b === "string" ? b : null)) : null
  return parallelLabelFromBadges(badges)
}

/** "<set> · <parallel> · <play> · <date> · /<circ>", each part only when present. */
export function editionTitleContext(p: Payload, collectionUrlSlug: string, setFallback = "Edition"): string {
  const parts: (string | null)[] = [str(p, "set_name") ?? setFallback, editionParallelName(p, collectionUrlSlug)]
  if (PLAY_COLLECTIONS.has(collectionUrlSlug)) {
    parts.push(str(p, "play_category") ?? str(p, "play_type"), formatGameDate(p.game_date))
  }
  if (CIRCULATION_COLLECTIONS.has(collectionUrlSlug)) {
    const c = p.circulation_count
    const circ = typeof c === "number" ? c : typeof c === "string" && /^\d+$/.test(c) ? Number(c) : null
    if (circ != null && circ > 0) parts.push(`/${circ}`)
  }
  return parts.filter((x): x is string => !!x).join(" · ")
}

/**
 * "<play> · <date>" for an edition GRID TILE (2026-10-21, 20261021145002) —
 * the same play + date the page title carries, so a player's several editions
 * in one set are not identical tiles (Kon Knueppel's Signature Series 1/1s
 * read "Signature Series · ULTIMATE · Series 2025-26" three times). Top Shot,
 * All Day, Golazos only; null when neither part is known. A team moment's tile
 * subject already names its play, so only the date is added there.
 */
export function editionPlayLabel(p: Payload, collectionUrlSlug: string): string | null {
  if (!PLAY_COLLECTIONS.has(collectionUrlSlug)) return null
  const isTeamMoment = !str(p, "player_name")
  const play = isTeamMoment ? null : (str(p, "play_category") ?? str(p, "play_type"))
  const parts = [play, formatGameDate(p.game_date)].filter((x): x is string => !!x)
  return parts.length ? parts.join(" · ") : null
}
