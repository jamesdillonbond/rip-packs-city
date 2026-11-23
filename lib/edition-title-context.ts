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
import { parseGameDate } from "@/lib/game-date"

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
  // 2026-11-06: the epoch sentinel ("1970-01-01", Top Shot's off-court
  // content) is "unknown", never a date — 14 Fit Check titles read
  // "Jan 1, 1970" live. lib/game-date.ts (parseGameDate).
  const d = parseGameDate(v)
  if (!d) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
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

/**
 * The subject a page leads with: the player, else the team, else the edition's own name. The same
 * fallback order as lib/seo.ts and the edition page's hero.
 */
export function editionSubject(p: Payload): string | null {
  return str(p, "player_name") ?? str(p, "team_name") ?? str(p, "name")
}

/**
 * "<set> · <parallel> · <play> · <date> · /<circ>", each part only when present.
 *
 * 2026-11-23: the SET is dropped when the page's own subject already IS the set. A no-player, no-team
 * edition whose name is its set name (356 live pages: Candy "2022 Opening Day Pin" ×320, All Day
 * "NFL Draft" draft-pick vouchers ×36) read "NFL Draft — NFL Draft · Draft Pick …" in its <title>,
 * meta description and JSON-LD. The result can now be EMPTY (Candy has no play/circulation parts),
 * so callers join it with `subjectWithContext`, never a bare template.
 */
export function editionTitleContext(p: Payload, collectionUrlSlug: string, setFallback = "Edition"): string {
  const set = str(p, "set_name") ?? setFallback
  const subject = editionSubject(p)
  const setRepeatsSubject = !!subject && subject.trim().toLowerCase() === set.trim().toLowerCase()
  const parts: (string | null)[] = [setRepeatsSubject ? null : set, editionParallelName(p, collectionUrlSlug)]
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

/** "<subject><sep><context>", or the subject alone when the context is empty. */
export function subjectWithContext(subject: string, context: string, sep = " — "): string {
  return context ? `${subject}${sep}${context}` : subject
}
