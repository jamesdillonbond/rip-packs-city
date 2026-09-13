// lib/og/trophy-detail.ts
//
// The per-Moment DETAIL LINES a share card draws under a trophy.
//
// Trevor, 2026-09-12: "we need more details on these moments when showing them
// off."
//
// ── THE CARD WAS DISCARDING ITS BEST FACTS ──────────────────────────────────
// `get_trophy_slab_data_by_username` already returns `set_name`, `series`,
// `serial_number`, `circulation_count`, `team_name`, `play_description`, `fmv`
// and `acquisition_method`. Both trophy cards fetched all of it and then
// narrowed each row to { art, tier, player, marks } — so on Trevor's own card:
//
//   card showed          | it actually is
//   ---------------------|--------------------------------------------------
//   Donovan Clingan      | serial #1 OF 1 — a one-of-one Ultimate, Series 7
//   Kevin Durant         | #9 of 10 — Supernova, Ultimate, Series 7
//   Damian Lillard       | #5 of 28 — Run It Back: Legacies, Series 5
//   LeBron James         | #56 of 99 — The Anthology, Legendary, Series 5
//
// A 1-of-1 is the most impressive object in that case and the card was silent
// about it. "#5 / 28" says more to a collector in five characters than the
// thumbnail does at that size. (Verified against the live RPC, 2026-09-12.)
//
// ── TWO DELIBERATE CALLS ────────────────────────────────────────────────────
//  * SPECIAL SERIALS ARE LOUD. A 1-of-1, a jersey match and a perfect mint get
//    gold on the SERIAL LINE ITSELF, not only a mark in the badge row. It is
//    the fact people screenshot, and a 16px glyph is not where you put the
//    headline.
//  * FMV STAYS OFF. `PORTFOLIO FMV` came off the profile card on 2026-09-12 —
//    Trevor's call, and a privacy repair, since every share was broadcasting a
//    collector's net worth to a public timeline. Scarcity is the flex. Putting
//    a per-Moment price back here would undo that decision by a side door, so
//    `fmv` is read by nothing in this module on purpose.
//
// ⚠ EVERY LINE THIS MODULE PRODUCES MUST BE HEIGHT-RESERVED BY THE CALLER.
// The badge row in both cards is `height: markSize` ALWAYS RENDERED, and that
// is not tidiness — the tiles are centred in the shelf, so a Moment with one
// fewer line is a SHORTER column and satori centres it LOWER. Simba sat 10px
// below his five neighbours until that was fixed. Adding text lines re-opens
// exactly that trap: a Moment with no set name would drop its neighbour's art
// off the shared baseline. `trophyDetail` therefore returns a FIXED-LENGTH
// shape whose fields are "" rather than absent, so a caller that renders every
// field renders every row at the same height.

import { specialCats } from "@/lib/badges/glyphs"

export interface TrophyDetailSource {
  serial_number?: number | null
  circulation_count?: number | null
  tier?: string | null
  set_name?: string | null
  series?: number | string | null
  play_description?: string | null
}

export interface TrophyDetail {
  /** e.g. "#1 / 1" — "" when the serial is unknown. */
  serial: string
  /** e.g. "ULTIMATE" — "" when the tier is unknown. */
  tier: string
  /** e.g. "2024 Rookie Ultimates" — "" when there is no set. */
  set: string
  /** e.g. "Series 7 · Reel" — "" when neither part is known. */
  context: string
  /**
   * True when the serial is a #1, a perfect mint, or (caller-supplied) a
   * jersey match — i.e. when the serial line should be drawn GOLD.
   */
  special: boolean
}

/**
 * Truncate to a character budget with a real ellipsis.
 *
 * ⚠ BY CHARACTER COUNT, NOT BY CSS. satori implements `text-overflow: ellipsis`
 * only alongside a working `overflow` + fixed width, and silently no-ops often
 * enough that a long set name escapes its tile instead of clipping. Counting
 * characters is crude but it is the thing that actually holds at 165px.
 *
 * ⚠ The ellipsis is "…" (U+2026), ONE character, not three dots — three dots
 * cost three glyph slots in the budget it is supposed to be respecting.
 */
export function clip(s: string, max: number): string {
  const t = s.trim()
  if (max <= 0) return ""
  if (t.length <= max) return t
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

/**
 * "#5 / 28", "#1 / 1", or "#56" when circulation is unknown.
 *
 * ⚠ SPACED AROUND THE SLASH. At 11px mono on a dark tile "#56/99" reads as one
 * token; the spaces are what make the two numbers legible as a ratio, which is
 * the entire point of drawing it.
 */
export function serialLine(
  serial: number | null | undefined,
  circulation: number | null | undefined,
): string {
  if (serial == null || !Number.isFinite(Number(serial)) || Number(serial) <= 0) return ""
  const s = `#${Number(serial).toLocaleString()}`
  if (circulation == null || !Number.isFinite(Number(circulation)) || Number(circulation) <= 0) {
    return s
  }
  return `${s} / ${Number(circulation).toLocaleString()}`
}

/**
 * "Series 7 · Reel" — the series label and the play description, whichever of
 * them exist.
 *
 * ⚠ `series` IS DISPLAY, NOT ON-CHAIN, on this row. `editions.series` is the
 * display number and `wmc.series_number` is the on-chain one; they collide on
 * Top Shot, where there is no on-chain series 1 and series 0 IS Series 1. This
 * function formats whatever the trophy RPC handed it and does NOT remap —
 * a blanket 1→0 remap across collections silently dropped 385,734 Top Shot
 * rows on 2026-08-05, and All Day / Golazos / Pinnacle use 1 legitimately.
 * (Trevor's All Day Moment reads series 1 and is genuinely Series 1.)
 */
export function contextLine(
  series: number | string | null | undefined,
  playDescription: string | null | undefined,
): string {
  const parts: string[] = []
  const s = typeof series === "number" ? String(series) : (series ?? "").toString().trim()
  if (s) parts.push(/^\d+$/.test(s) ? `Series ${s}` : s)
  const play = (playDescription ?? "").trim()
  if (play) parts.push(play)
  return parts.join(" · ")
}

/**
 * Derive every detail line for one trophy row.
 *
 * `jersey` is passed in rather than read, for the same reason `trophyMarks`
 * takes it: it is the one fact the trophy RPC does not return, it comes from a
 * separate bounded read, and a failed read must cost the gold treatment on the
 * serial line and nothing else.
 *
 * `budget` is the character budget for the two wrapping lines — the caller
 * knows its tile width, this module does not.
 */
export function trophyDetail(
  row: TrophyDetailSource,
  jersey: number | null = null,
  budget = 24,
): TrophyDetail {
  const serial = serialLine(row.serial_number, row.circulation_count)
  // Reuses the CANONICAL special-serial definition rather than re-testing
  // `serial === 1` locally — the guards in it are load-bearing (a 1-of-1 is
  // `first` and NOT also a perfect mint; `jersey_number` 0 means NO NUMBER,
  // not a number to match) and a second copy is how the card and the badge row
  // end up disagreeing about the same Moment.
  const special =
    specialCats(row.serial_number ?? null, row.circulation_count ?? null, jersey).length > 0

  return {
    serial,
    tier: (row.tier ?? "").trim().toUpperCase(),
    // ⚠ TRIMMED, and live data is why: Disney Pinnacle set names arrive with a
    // LEADING SPACE (" Walt Disney Animation Studios • The Lion King Vol.2"),
    // which at this size reads as a misaligned line rather than as a space.
    set: clip(row.set_name ?? "", budget),
    context: clip(contextLine(row.series, row.play_description), budget),
    special,
  }
}
