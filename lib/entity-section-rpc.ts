// lib/entity-section-rpc.ts
//
// The SECTION-level fetch policy for the five entity SEO routes
// (edition / set / player / team / series). The *detail* fetch already has a
// policy — see lib/entity-detail-gate.ts, which retries connection-class errors
// and then throws so a transient blip renders a retryable error boundary rather
// than a 404. This module gives the sections BELOW the hero the same treatment.
//
// ── The defect this closes (2026-07-26) ────────────────────────────────────
// Every section fetcher on these pages was written as:
//
//     const { data, error } = await rpc().rpc("get_team_players", {...})
//     if (error) { console.error(...); return [] }
//
// Two independent problems with that shape:
//
//  1. NO RETRY. The team page fires SIX section RPCs in a single Promise.all,
//     concurrent with the detail fetch — seven pooled connections per request.
//     That fan-out is exactly what produced the pool-acquire timeouts Sentry
//     recorded on GET /[collection]/team/[slug] (8 events) and
//     GET /[collection]/player/[slug] (4 events). Those pool blips self-heal in
//     well under a second; the detail fetch already rides them out with
//     rpcWithRetry, and the sections had no such protection.
//
//  2. THE FAILURE IS INVISIBLE. `return []` renders a PLAUSIBLE EMPTY STATE —
//     a Miami Heat page with an empty roster looks exactly like a team we have
//     no data for. Nothing throws, nothing reaches Sentry, no health check
//     fires, and Google may well crawl the thin version. This is the same
//     silent-failure class as a slow view rendering empty: verify the end
//     state, never the ack.
//
// ── The policy ──────────────────────────────────────────────────────────────
// STRUCTURAL sections (the roster on a team page, the editions grid on a player
// page) are the reason the page exists. If one fails after retries, we THROW —
// same reasoning the detail fetch throws: an honest retryable error beats a
// convincing lie, and it keeps a thin page out of the index.
//
// DECORATIVE sections (recent activity, squeeze, next game, top sales, top
// collectors) degrade to empty after retries, because the page is still worth
// serving without them. They log with a stable `[entity-section]` prefix so the
// degradation is greppable in Vercel logs instead of being indistinguishable
// from a genuinely empty section.
//
// Retries are cheap here and bounded: rpcWithRetry stops immediately on 42xxx
// logic-class errors, so a bad argument still fails fast on the first attempt.
//
// ── ⚠ THE GAP THIS POLICY LEFT OPEN, closed 2026-08-21 ─────────────────────
// The comment above says `return []` "renders a PLAUSIBLE EMPTY STATE" and then
// returns [] anyway for a decorative section, on the reasoning that the log line
// makes the degradation greppable. **The log is for the operator. The reader was
// still told something false.** Measured on 2026-08-21: a failed
// `get_edition_recent_sales` degrades to [] and the edition page renders
// "No sales yet." — a factual claim about the data, published out of a failed
// read, on the highest-traffic public page in the product (~750 such renders in
// 24h across recent-sales / offers / top-sales / FMV-history / parallels).
//
// ⚠ The two adjacent tests in __tests__/entity-section-rpc.test.ts prove it side
// by side: "an empty result is NOT an error" asserts `toEqual([])`, and
// "degrades to empty for a decorative section" asserts `toEqual([])`. Same value,
// two different states — the two-state collapse the honesty canon forbids, sitting
// under a ledger entry that called it "the three-state distinction the canon
// requires". A helper cannot be the reason a caller lies: at [] the caller has
// nothing left to discriminate on.
//
// ⚠ THE DEGRADE/THROW POLICY IS UNCHANGED. A decorative section still degrades;
// that decision is Trevor's and it is sound. What changes is that the degradation
// is now VISIBLE to the caller — `sectionRowsResult` / `sectionRowResult` carry
// `ok`, so a section can render "unavailable" instead of concluding "none".
// `sectionRows` / `sectionRow` keep their exact signatures and are implemented on
// top, so no existing caller changes behaviour.
//
// NOTE: the follow-on conversion is DONE. Beyond the player and team routes
// Sentry originally named, the edition / set / series routes now route their
// list- and object-shaped section fetchers through sectionRows / sectionRow too.
// The handful of fetchers left on a raw supabaseAdmin call are deliberate — their
// failure fallback is a typed empty object (edition's market_bundle /
// insight_links) or a paged direct-table read (set's tier mix), neither of which
// is the [] / null contract this helper models, so routing them here would change
// their shape. Keep any NEW list/object section fetcher on this helper so the
// structural-vs-decorative degradation stays consistent across entity pages.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export interface SectionOptions {
  /**
   * A structural section is the page's reason for existing. When true, an
   * error surviving all retries THROWS instead of degrading to empty.
   */
  structural?: boolean
}

function report(tag: string, fn: string, message: string, structural: boolean): void {
  const disposition = structural ? "STRUCTURAL — throwing" : "degrading to empty"
  console.error(`[entity-section] ${tag} ${fn} failed after retries: ${message} — ${disposition}`)
}

/**
 * Fetch a list-shaped section. Returns [] when the RPC succeeds and has no
 * rows (a genuinely empty section) — and, for a decorative section, also when
 * it fails after retries. A structural section throws instead.
 */
export async function sectionRows<T>(
  tag: string,
  fn: string,
  args: Record<string, unknown>,
  opts: SectionOptions = {},
): Promise<T[]> {
  return (await sectionRowsResult<T>(tag, fn, args, opts)).rows
}

/**
 * The three-state form of {@link sectionRows}, for any section whose empty copy
 * CONCLUDES ("No sales yet.") rather than merely showing nothing.
 *
 * - read failed, decorative  → `{ rows: [], ok: false, error }`
 * - read failed, structural  → throws (unchanged)
 * - read ok, genuinely empty → `{ rows: [], ok: true }`
 * - read ok, rows            → `{ rows, ok: true }`
 *
 * ⚠ `ok` is what a caller needs to tell the first case from the third. Without
 * it every consumer of a degraded section is FORCED to publish "none" for
 * "we could not look" — which is the defect, not the caller's fault.
 */
export async function sectionRowsResult<T>(
  tag: string,
  fn: string,
  args: Record<string, unknown>,
  opts: SectionOptions = {},
): Promise<{ rows: T[]; ok: boolean; error?: string }> {
  const structural = opts.structural === true
  const { data, error } = await rpcWithRetry(supabaseAdmin as never, fn, args)
  if (error) {
    report(tag, fn, error.message, structural)
    if (structural) throw new Error(`${tag} unavailable: ${error.message}`)
    return { rows: [], ok: false, error: error.message }
  }
  return { rows: Array.isArray(data) ? (data as T[]) : [], ok: true }
}

/**
 * Fetch an object-shaped section (a single jsonb row). Returns null when the
 * RPC succeeds with no row, and — for a decorative section — when it fails
 * after retries. A structural section throws instead.
 */
export async function sectionRow<T>(
  tag: string,
  fn: string,
  args: Record<string, unknown>,
  opts: SectionOptions = {},
): Promise<T | null> {
  return (await sectionRowResult<T>(tag, fn, args, opts)).row
}

/** The three-state form of {@link sectionRow}. See {@link sectionRowsResult}. */
export async function sectionRowResult<T>(
  tag: string,
  fn: string,
  args: Record<string, unknown>,
  opts: SectionOptions = {},
): Promise<{ row: T | null; ok: boolean; error?: string }> {
  const structural = opts.structural === true
  const { data, error } = await rpcWithRetry(supabaseAdmin as never, fn, args)
  if (error) {
    report(tag, fn, error.message, structural)
    if (structural) throw new Error(`${tag} unavailable: ${error.message}`)
    return { row: null, ok: false, error: error.message }
  }
  if (data == null) return { row: null, ok: true }
  if (Array.isArray(data)) return { row: (data[0] as T) ?? null, ok: true }
  return { row: data as T, ok: true }
}

/**
 * Catch a STRUCTURAL section's throw AT THE PAGE, so the failure costs the
 * reader that SECTION instead of the whole page.
 *
 * ── Why this exists (R19, 2026-08-23) ──────────────────────────────────────
 * The throw above is correct and stays: a structural section must never render
 * a real entity with a convincingly empty catalogue. But every entity page
 * caught it at the OUTERMOST level and returned its whole-page `*Unavailable`,
 * which throws away everything the page already knows. On
 * `/nba-top-shot/series/series-7` that is the whole hero and all five stat
 * cells — `get_series_detail` answers in ~18 ms off `series_detail_rollup`
 * while `get_series_editions` costs 6,615 ms / 32,484 buffers against an 8 s
 * ceiling (R49). The reader was shown "couldn't load series-7" on a page whose
 * name, season, edition count, set count, player count, FMV total and floor
 * total were all sitting in memory, already read, already true.
 *
 * ⚠ It is also the DECORATIVE sections' problem, not only the structural one:
 * a structural throw inside a shared `Promise.all` rejects the whole call and
 * discards siblings that SUCCEEDED. The team page fans out six ways, so one
 * roster timeout cost five sections that had already come back.
 *
 * ⚠ `ok: false` is NOT `rows: []`. A caller that renders the empty array is
 * back to publishing "none" for "we could not look" — the two-state collapse
 * this file's header spends forty lines on. Render a section-level unavailable
 * on `!ok`; `[]` here is only so the type stays a list.
 */
export async function structuralSection<T>(
  tag: string,
  read: Promise<T[]>,
): Promise<{ rows: T[]; ok: boolean }> {
  try {
    return { rows: await read, ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[entity-section] ${tag} structural read failed — degrading the SECTION, not the page: ${message}`)
    return { rows: [], ok: false }
  }
}
