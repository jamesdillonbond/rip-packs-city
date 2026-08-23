// lib/admin/error-triage.ts
//
// The two reads behind /admin/flowty-errors — Trevor's error-triage console.
//
// WHY THEY MOVED OUT OF page.tsx. Same two reasons as every other extraction in
// this family:
//
//  1. UNBOUNDED. Both `.rpc()` calls were awaited inline by a server component
//     with no Suspense boundary. A read that is merely SLOW errors nowhere —
//     supabase-js resolves `{ data, error }` only when the query finishes — so a
//     saturated DB left the console waiting on a streaming shell that Vercel
//     logs as a 200. ⚠ This page is `force-dynamic`, so EVERY visit pays it;
//     there is no ISR entry to hide behind.
//
//  2. UNTESTABLE. `app/**/page.tsx` is measured by NEITHER coverage gate, so the
//     `loadError` distinction below had nothing pinning it.
//
// ⚠ AN OPERATOR CONSOLE, AND THE DRIVER MESSAGE IS KEPT ON PURPOSE. `error`
// carries the raw Postgres message straight to the client, which
// `scripts/check-driver-message-leaks.mjs` bans on user-facing API handlers and
// deliberately exempts for gated operator sites. This is one: `/admin/*` is
// reachable only with `RPC_ADMIN_TOKEN`, the reader is the operator, and the
// message is the point of the screen. Do not "harden" it into a generic string —
// that would remove the only diagnostic the console has.
//
// ⚠ BUT A TIMEOUT IS NOT A DRIVER MESSAGE, and it must not pretend to be. The
// bound reports its own sentence, so the operator can tell "Postgres said X"
// from "we never heard back" — two different investigations.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * ⚠ Both RPCs aggregate the whole `flowty_errors` triage table, so they are
 * board-shaped rather than keyed lookups. The two run in ONE `Promise.all`, so
 * this budget is the page's ceiling rather than twice it.
 */
export const ERROR_TRIAGE_TIMEOUT_MS = 8_000

export interface ErrorTriageResult<D, S> {
  dashboard: D | null
  summary: S[]
  /** Null when both reads succeeded. A message here is for the OPERATOR. */
  error: string | null
}

export async function loadErrorTriage<D, S>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = ERROR_TRIAGE_TIMEOUT_MS,
): Promise<ErrorTriageResult<D, S>> {
  let dashRes: { data: unknown; error: { message: string } | null }
  let sumRes: { data: unknown; error: { message: string } | null }
  try {
    ;[dashRes, sumRes] = await withBoardBudget<
      [
        { data: unknown; error: { message: string } | null },
        { data: unknown; error: { message: string } | null },
      ]
    >(
      Promise.all([
        db.rpc("get_error_triage_dashboard"),
        db.rpc("get_error_triage_summary", { p_status_filter: null }),
      ]) as Promise<
        [
          { data: unknown; error: { message: string } | null },
          { data: unknown; error: { message: string } | null },
        ]
      >,
      "error-triage",
      timeoutMs,
      "admin/",
    )
  } catch (e) {
    console.log("[flowty-errors] read bound:", e instanceof Error ? e.message : e)
    // ⚠ Its OWN sentence, not a fabricated driver message. "Postgres answered
    // with an error" and "Postgres never answered" send an operator down
    // different paths, and only one of them is a query bug.
    return {
      dashboard: null,
      summary: [],
      error: `Triage reads did not complete within ${timeoutMs}ms — the database did not answer.`,
    }
  }

  let error: string | null = null
  let dashboard: D | null = null
  let summary: S[] = []

  if (dashRes.error) {
    console.log(`[flowty-errors] dashboard rpc error: ${dashRes.error.message}`)
    error = dashRes.error.message
  } else {
    const d = dashRes.data
    // The RPC may return a scalar JSON object or a single-row array.
    if (Array.isArray(d)) dashboard = (d[0] ?? null) as D | null
    else if (d && typeof d === "object") dashboard = d as D
  }

  if (sumRes.error) {
    console.log(`[flowty-errors] summary rpc error: ${sumRes.error.message}`)
    // ⚠ First error wins, matching the page's prior behaviour: the console shows
    // one banner, and overwriting it would hide whichever failure came first.
    if (!error) error = sumRes.error.message
  } else if (Array.isArray(sumRes.data)) {
    summary = sumRes.data as S[]
  }

  return { dashboard, summary, error }
}
