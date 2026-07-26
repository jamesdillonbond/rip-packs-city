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
// NOTE: the edition / set / series routes have the same `return []` shape in
// ~18 more fetchers and are the obvious next candidates. They are deliberately
// NOT converted here — player and team are the two routes Sentry actually named,
// and a narrow change is verifiable.

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
  const structural = opts.structural === true
  const { data, error } = await rpcWithRetry(supabaseAdmin as never, fn, args)
  if (error) {
    report(tag, fn, error.message, structural)
    if (structural) throw new Error(`${tag} unavailable: ${error.message}`)
    return []
  }
  return Array.isArray(data) ? (data as T[]) : []
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
  const structural = opts.structural === true
  const { data, error } = await rpcWithRetry(supabaseAdmin as never, fn, args)
  if (error) {
    report(tag, fn, error.message, structural)
    if (structural) throw new Error(`${tag} unavailable: ${error.message}`)
    return null
  }
  if (data == null) return null
  if (Array.isArray(data)) return (data[0] as T) ?? null
  return data as T
}
