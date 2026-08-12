// Throttle-immune default-payload cache for the hottest public /insights boards.
//
// WHY THIS EXISTS (nc1 PUBLIC-BOARD-CACHING, 2026-08-09). The public board SERVER
// pages (`app/insights/<board>/page.tsx`, ISR `revalidate = 300`) fetch heavy
// queries against multi-GB backing views directly from supabaseAdmin on every
// revalidation. When Supabase's disk-IO budget depletes the DB throttles to
// ~22 MB/s and those views 500 / time out (57014) — the hottest public read paths
// fail first. The failing revalidation then caches an EMPTY page for the next 300s.
// The Aug-9 board-status work made that failure HONEST; this layer makes it RARE:
//
//   1. A background cron (/api/cron/refresh-insights-cache) runs each board's heavy
//      default query and writes the JSON payload into public_board_snapshots — ONE
//      writer, off the user-facing render path.
//   2. The pages/routes READ that snapshot. A fresh snapshot is served directly (a
//      single tiny PK-keyed row lookup survives IO throttling that the full views
//      cannot), so the heavy query never runs during a page render.
//   3. If the snapshot is stale/absent the consumer runs the live query as before;
//      and if THAT fails, it serves the last-good snapshot (marked stale) instead of
//      an empty page — a stale-but-honest render beats a blank one for a public board.
//
// Every operation is FAIL-OPEN: any cache error returns null / no-ops, so the worst
// case is exactly the pre-cache behavior (a live query, empty on failure). Consumers
// never WRITE (no DB side-effect during render); only the cron writes. Rollout is
// strictly non-regressive — before the first cron tick the boards behave as today,
// then gain resilience once warm. The table is service_role only (anon/authenticated
// SELECT-revoked); all access is via supabaseAdmin.

import { supabaseAdmin } from "@/lib/supabase"

/** How long a snapshot counts as "fresh" for the fast path. Comfortably above the
 *  cron interval (every 5 min) so a page read almost always hits a fresh row, while
 *  a few dropped cron ticks still fall back to a live re-warm rather than serving
 *  wildly stale data. */
export const BOARD_CACHE_FRESH_MS = 10 * 60 * 1000

/** Board keys — one per cached board. Keep in sync with WARM_BOARDS + the pages. */
export type BoardCacheKey =
  | "deals"
  | "rookies"
  | "first-mint"
  | "candy-mlb"
  | "panini-squeeze"

/** The hot boards the cron proactively warms. `label` feeds the cron's per-board
 *  telemetry; `key` is the snapshot row + the value each page passes to the cache. */
export const WARM_BOARDS: { key: BoardCacheKey; label: string }[] = [
  { key: "deals", label: "Below FMV" },
  { key: "rookies", label: "2025 Rookie Index" },
  { key: "first-mint", label: "First-Mint Trophies" },
  { key: "candy-mlb", label: "Candy MLB ICONs" },
  { key: "panini-squeeze", label: "Panini WC Squeeze" },
]

/** What a board's live-fetch closure returns. `ok` is true ONLY when every backing
 *  query succeeded — an errored/partial fetch must never be cached and must trigger
 *  the stale fallback. `rowCount` is stored for cron telemetry / observability. */
export interface BoardLiveResult<T extends Record<string, unknown>> {
  payload: T
  ok: boolean
  rowCount: number | null
  /**
   * WHY a fetch reported ok:false — for the CRON'S TELEMETRY ONLY.
   *
   * Measured 2026-08-12 over 6h / 68 warm runs: `deals` warmed 19% of the time and
   * `first-mint` 16%, and every pipeline_runs row read exactly
   * `"deals; first-mint; panini-squeeze"` — the failing board KEYS with no reason,
   * because warmBoard only carried an error when the closure THREW, and these
   * fetchers do not throw: they reduce a PostgrestError to `ok: !error` and drop it.
   * So the estate had recorded 68 times that a board failed and zero times why.
   *
   * ⚠ This is the LOG side of the same rule lib/api-error.ts enforces on the
   * response side: classify what you publish, but keep the real detail where an
   * operator can read it. It lands in `pipeline_runs.error`, a service-role-only
   * table — it is NOT user-facing, so a driver message belongs here. Do not
   * "fix" this into a classified string, and do not surface it on a board.
   *
   * readBoardOrLive deliberately ignores it: consumers must never publish it.
   */
  error?: string
}

/**
 * Build a telemetry reason from a set of named sub-fetches. Boards assemble several
 * queries, so "which one failed" is the whole diagnostic value — a bare board key
 * (what we had) cannot distinguish a timed-out view from a dropped column.
 */
export function describeBoardFailures(
  parts: { label: string; ok: boolean; error?: string | null }[]
): string | undefined {
  const failed = parts.filter((p) => !p.ok)
  if (!failed.length) return undefined
  return failed.map((p) => (p.error ? `${p.label}: ${p.error}` : p.label)).join(", ")
}

export interface BoardSnapshot {
  payload: Record<string, unknown>
  ageMs: number
  stale: boolean
  refreshedAt: string
}

/** Where a served payload came from. `fresh-cache` = the fast path; `stale-cache` =
 *  the live query failed and we fell back to the last-good snapshot. */
export type BoardSource = "fresh-cache" | "live" | "stale-cache" | "live-degraded"

/**
 * Read a board's cached payload. Returns null when absent or on ANY error
 * (fail-open). Never throws. `stale` is informational — the caller serves a fresh
 * snapshot directly and only uses a stale one as a fallback when the live query fails.
 */
export async function readBoardSnapshot(
  key: BoardCacheKey
): Promise<BoardSnapshot | null> {
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("public_board_snapshots")
      .select("payload, refreshed_at")
      .eq("board_key", key)
      .maybeSingle()
    if (error || !data?.payload || !data?.refreshed_at) return null
    const refreshedMs = new Date(data.refreshed_at).getTime()
    if (!Number.isFinite(refreshedMs)) return null
    const ageMs = Date.now() - refreshedMs
    return {
      payload: data.payload as Record<string, unknown>,
      ageMs,
      stale: ageMs > BOARD_CACHE_FRESH_MS,
      refreshedAt: data.refreshed_at as string,
    }
  } catch {
    return null
  }
}

/**
 * Write (upsert) a board's payload. Best-effort — swallows every error so a cache
 * write can never fail the caller. Only the cron calls this (single-writer model).
 */
export async function writeBoardSnapshot(
  key: BoardCacheKey,
  payload: Record<string, unknown>,
  rowCount: number | null
): Promise<void> {
  try {
    await (supabaseAdmin as any).from("public_board_snapshots").upsert(
      {
        board_key: key,
        payload,
        row_count: rowCount,
        refreshed_at: new Date().toISOString(),
      },
      { onConflict: "board_key" }
    )
  } catch {
    /* fail-open: a cache write must never break the caller */
  }
}

/**
 * Merge cache-provenance markers into a payload's `meta` before serving from the
 * cache. Pure — returns a new object, does not mutate the input.
 */
export function withCacheMeta(
  payload: Record<string, unknown>,
  snap: { ageMs: number; stale: boolean; refreshedAt: string }
): Record<string, unknown> {
  const meta = (payload.meta as Record<string, unknown> | undefined) ?? {}
  return {
    ...payload,
    meta: {
      ...meta,
      served_from_cache: true,
      cache_age_ms: snap.ageMs,
      cache_stale: snap.stale,
      cache_refreshed_at: snap.refreshedAt,
    },
  }
}

/**
 * Consumer entry point (pages + routes). Resolve a board's default payload with the
 * fresh-snapshot → live → stale-snapshot ladder. Never writes.
 *
 *   fresh snapshot present  → serve it            (source: "fresh-cache")
 *   else live query ok      → serve it            (source: "live")
 *   else stale snapshot     → serve it, marked    (source: "stale-cache")
 *   else                    → serve live's payload (source: "live-degraded", may be empty)
 */
export async function readBoardOrLive<T extends Record<string, unknown>>(
  key: BoardCacheKey,
  live: () => Promise<BoardLiveResult<T>>
): Promise<{ payload: T; source: BoardSource }> {
  const fresh = await readBoardSnapshot(key)
  if (fresh && !fresh.stale) {
    return { payload: withCacheMeta(fresh.payload, fresh) as T, source: "fresh-cache" }
  }

  let res: BoardLiveResult<T> | null = null
  try {
    res = await live()
  } catch {
    res = null
  }
  if (res && res.ok) {
    return { payload: res.payload, source: "live" }
  }

  // Live query errored/threw — fall back to the last-good snapshot at any age.
  const stale = fresh ?? (await readBoardSnapshot(key))
  if (stale) {
    return { payload: withCacheMeta(stale.payload, stale) as T, source: "stale-cache" }
  }
  // Nothing cached at all — hand back whatever live produced (typically empty), so
  // behavior is identical to the pre-cache code path.
  return { payload: (res?.payload ?? ({} as T)), source: "live-degraded" }
}

/**
 * Cron entry point. Run the board's live query and write the snapshot when it
 * succeeded. Returns a telemetry summary; never throws.
 */
export async function warmBoard<T extends Record<string, unknown>>(
  key: BoardCacheKey,
  live: () => Promise<BoardLiveResult<T>>
): Promise<{ key: BoardCacheKey; ok: boolean; rowCount: number | null; error?: string }> {
  let res: BoardLiveResult<T> | null = null
  try {
    res = await live()
  } catch (e) {
    return { key, ok: false, rowCount: null, error: e instanceof Error ? e.message : String(e) }
  }
  if (!res.ok) {
    // Carry the fetcher's reason through. Before 2026-08-12 this dropped it, so a
    // board failing 84% of the time produced telemetry that said only that it failed.
    return { key, ok: false, rowCount: res.rowCount, error: res.error }
  }
  await writeBoardSnapshot(key, res.payload, res.rowCount)
  return { key, ok: true, rowCount: res.rowCount }
}
