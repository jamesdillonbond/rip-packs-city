// lib/analytics/sets/detail-fetchers.ts
//
// The two database reads behind /analytics/sets/[set_id], extracted from that
// page so a coverage gate can see them.
//
// ── WHY THEY MATTER MORE THAN MOST ─────────────────────────────────────────
// This is the code that fixed a PRODUCTION BUILD FAILURE and a soft-404 in one
// change (2026-08-13), and until now it lived entirely in `app/**/page.tsx` —
// measured by neither coverage gate. The two properties it encodes are exactly
// the kind that look like dead defensive code to a future editor:
//
//   • THE TIMEOUT RACE. Next gives each page 60s to export and retries 3x before
//     killing the WHOLE build. A read that is merely SLOW is as unservable as one
//     that errored, and before this only the errored one was modelled.
//     `dynamicParams = true` is what makes the bound safe — an unbuilt set falls
//     through to ISR rather than 404ing.
//   • ERROR IS NOT ABSENCE. `loadSet` returns `ok` because the previous shape
//     returned a bare `null` for BOTH "no such set" and "the read failed", and
//     the caller answered `notFound()`. At request time that told a visitor a
//     real set does not exist; at BUILD time it BAKED that 404 into a static page
//     a crawler will believe.
//
// ⚠ A malformed id is `{ data: null, ok: TRUE }` — deliberately. That is an
// ANSWER ("no such set"), not a failure, and flipping it to false would put a
// permanent degraded state on every bad URL a crawler invents.
//
// The client is injectable so tests can drive both branches; it defaults to the
// service-role client the page used.

import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SetsDetailResponse, SetsDirectoryRow } from "@/lib/analytics-types"

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Per-page budget for the detail read.
 *
 * ⚠ Next gives each page 60s to export and retries 3x before killing the WHOLE
 * build. On 2026-08-13 a connection-pool saturation spell did exactly that here:
 * `analytics_sets_detail` blocked on "Timed out acquiring connection from
 * connection pool", rpcWithRetry (correctly) retried it as transient, and one of
 * the 100 prerendered sets blew the budget -> "Export encountered an error ...
 * exiting the build" -> `npm run build` exit 1, production deploy ERROR.
 *
 * This is the SECOND time a build-time DB read has taken the production build
 * down (the first was /insights/first-mint, fixed with BOARD_LIVE_TIMEOUT_MS in
 * lib/insights/board-cache.ts). Same shape, same remedy: bound it well under the
 * budget so a throttled DB degrades this page to ISR instead of failing the
 * deploy. `dynamicParams = true` already makes that fallback safe — an unbuilt
 * set is simply rendered on first request.
 */
export const SET_DETAIL_TIMEOUT_MS = 12_000

/**
 * Outcome of the detail read.
 *
 * ⚠ `ok` exists because the previous shape returned a bare `null` for BOTH "no
 * such set" and "the read failed", and the caller answered `notFound()`. So a
 * statement timeout told a visitor a real set does not exist — and at BUILD time
 * it BAKES that 404 into a static page, which a crawler will believe. Same class
 * the guard in __tests__/server-pages-error-vs-absent-guard.test.ts pins on
 * /[collection]/pack/[id] and /analytics/wallets; this was a third instance.
 */
export interface SetLoad {
  data: SetsDetailResponse | null
  ok: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadSet(setId: string, db: any = supabaseAdmin): Promise<SetLoad> {
  if (!UUID_RE.test(setId)) return { data: null, ok: true }
  // Catch INSIDE the raced promise so an abandoned query that fails later cannot
  // surface as an unhandled rejection after we have stopped listening.
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = (async (): Promise<SetLoad> => {
    try {
      const { data, error } = await rpcWithRetry<SetsDetailResponse>(
        db,
        "analytics_sets_detail",
        { p_set_id: setId }
      )
      if (error) {
        const msg = (error.message || "").toLowerCase()
        // A genuine "no such set" IS an answer — ok stays true.
        if (msg.includes("not found") || msg.includes("does not exist")) {
          return { data: null, ok: true }
        }
        console.log("[sets/detail/page] rpc_error", error.message)
        return { data: null, ok: false }
      }
      return { data: (data as SetsDetailResponse) ?? null, ok: true }
    } catch (e: any) {
      console.log("[sets/detail/page] error", e?.message || e)
      return { data: null, ok: false }
    }
  })()
  const timeout = new Promise<SetLoad>((resolve) => {
    timer = setTimeout(() => {
      console.log("[sets/detail/page] timeout", setId)
      // A read that is merely SLOW is as unservable as one that errored, and
      // before this only the errored one was modelled.
      resolve({ data: null, ok: false })
    }, SET_DETAIL_TIMEOUT_MS)
  })
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setDetailStaticParams(db: any = supabaseAdmin) {
  // Pre-render the top-100 highest-value sets so the most-trafficked detail
  // pages are pre-built. The rest fall through to ISR on first request.
  try {
    const { data, error } = await rpcWithRetry<SetsDirectoryRow[]>(
      db,
      "analytics_sets_directory",
      {
        p_collections: null,
        p_sort: "value_desc",
        p_min_coverage: 0,
        p_limit: 100,
      }
    )
    if (error || !Array.isArray(data)) return []
    return data
      .filter((r) => UUID_RE.test(r.set_id))
      .map((r) => ({ set_id: r.set_id }))
  } catch {
    return []
  }
}
