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

/**
 * Ceiling on the LIVE query inside readBoardOrLive's ladder.
 *
 * WHY (measured 2026-08-12, deploy dpl_FwbnxURHqSbbYRqCQus44Cxxgyhc, state ERROR):
 *
 *     Failed to build /insights/first-mint/page: /insights/first-mint (attempt 2 of 3)
 *     because it took more than 60 seconds. Retrying again shortly.
 *     ...after 3 attempts.
 *     Export encountered an error on /insights/first-mint/page, exiting the build.
 *     Error: Command "npm run build" exited with 1
 *
 * A DISK-IO SATURATION SPELL FAILED THE WHOLE PRODUCTION DEPLOY. The five callers
 * of readBoardOrLive are all prerendered board pages, and **the build is a render
 * too** — but there a slow board is not degraded, it is FATAL: Next gives each page
 * 60s, retries 3×, then exits the build. Every other consumer of this ladder can
 * afford to wait; the build cannot, and it is the one nobody had thought about.
 *
 * The stale rung already existed for exactly this board — first-mint's snapshot was
 * ~85 minutes old at build time, i.e. present and usable. It never got a chance,
 * because the ladder only falls back when the live query ERRORS, and a query that is
 * merely SLOW errors nowhere. So the fallback that would have saved the deploy sat
 * one line below a query nobody was timing.
 *
 * 8s is far below the 60s export budget and far above a healthy board (candy/rookies
 * warm in well under it). Exceeding it means the DB is throttling, which is precisely
 * when a stale-but-complete snapshot is the better answer.
 *
 * ⚠ The abandoned query keeps running server-side — supabase-js has no cancel. We
 * stop WAITING on it; we do not stop it. That is the intended trade: the page (or
 * the build) proceeds on last-good data instead of blocking on a throttled DB.
 */
export const BOARD_LIVE_TIMEOUT_MS = 8_000

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
 * Age ceiling past which a board's snapshot is a REPORTABLE problem rather than a
 * dropped tick. Distinct from BOARD_CACHE_FRESH_MS, which decides what the READER
 * does; this decides what the WRITER admits to.
 *
 * ⚠ CHOSEN FROM THE MEASURED DISTRIBUTION, not from taste (2026-08-15, 869 cron
 * ticks / 3.2 days of pipeline_runs). Per-tick warm failure is not rare and not a
 * defect — it is the saturation condition this cache exists to survive:
 *
 *     deals 59.5% of ticks failed · first-mint 54.2% · panini-squeeze 51.0%
 *     rookies 15.1% · candy-mlb 4.4%
 *
 * so any threshold near one tick would be red most of the time — the cry-wolf
 * outcome ufc_fmv_stale_hours already cost this repo. Consecutive-failure streaks:
 *
 *     414 streaks total · >=30 min: 75 · >=1 h: 34 · >=2 h: 4 · longest 34 ticks
 *
 * 2 h therefore fires ~1.2x/day on the genuinely exceptional case (a PUBLIC board
 * serving two-hour-old data) and stays quiet through ordinary rotation. Move it
 * with a fresh measurement, not a hunch.
 */
export const BOARD_SNAPSHOT_STALE_CEILING_MS = 2 * 60 * 60 * 1000

/** One board's snapshot age, for the cron's own honesty check. */
export interface BoardSnapshotAge {
  key: BoardCacheKey
  ageMs: number | null
  refreshedAt: string | null
}

/**
 * Ages of every warmed board's snapshot, in ONE read.
 *
 * WHY THIS EXISTS: the warm cron reports `ok` from the outcome of the tick it just
 * ran, and a tick's outcome says nothing about how long a board has actually gone
 * unrefreshed. Measured, those diverge hard — `deals` reached 34 consecutive failed
 * ticks (~2h50m) while every one of those runs logged `ok: true`, because
 * `okCount > 0` was satisfied by candy-mlb succeeding 95.6% of the time. The
 * per-tick rule is defensible; being unable to SEE the streak is not.
 *
 * Selects only the timestamp — never `payload`, which is multi-MB for panini.
 * Fail-open: an unreadable row reports `ageMs: null` (unknown), which callers must
 * treat as "cannot conclude", never as "fresh".
 */
export async function readBoardSnapshotAges(): Promise<BoardSnapshotAge[]> {
  const unknown = WARM_BOARDS.map(({ key }) => ({ key, ageMs: null, refreshedAt: null }))
  try {
    const { data, error } = await (supabaseAdmin as any)
      .from("public_board_snapshots")
      .select("board_key, refreshed_at")
    if (error || !Array.isArray(data)) return unknown
    const byKey = new Map<string, string>()
    for (const row of data) {
      if (typeof row?.board_key === "string" && typeof row?.refreshed_at === "string") {
        byKey.set(row.board_key, row.refreshed_at)
      }
    }
    const now = Date.now()
    return WARM_BOARDS.map(({ key }) => {
      const refreshedAt = byKey.get(key) ?? null
      const ms = refreshedAt ? new Date(refreshedAt).getTime() : NaN
      return {
        key,
        ageMs: Number.isFinite(ms) ? now - ms : null,
        refreshedAt,
      }
    })
  } catch {
    return unknown
  }
}

/**
 * The boards whose snapshot has aged past the reportable ceiling.
 *
 * ⚠ An UNKNOWN age (`null`) is deliberately NOT reported as stale. A board that has
 * never been warmed has no snapshot row at all, and a failed read is not evidence of
 * staleness — calling either one "stale" would manufacture the finding out of our own
 * missing data, which is the failure this repo keeps paying for. It is a real absence
 * worth seeing, so it is counted separately by the caller rather than folded in here.
 */
export function stalestBoards(
  ages: BoardSnapshotAge[],
  ceilingMs: number = BOARD_SNAPSHOT_STALE_CEILING_MS
): BoardSnapshotAge[] {
  return ages
    .filter((a) => a.ageMs != null && a.ageMs > ceilingMs)
    .sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))
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
 * Run the live fetch with a wall-clock ceiling. Returns null when it fails OR when
 * it outlasts the budget, so BOTH collapse into the same "fall back to the stale
 * snapshot" branch — a slow board and a broken board are equally unservable, and
 * before 2026-08-12 only the broken one was handled (see BOARD_LIVE_TIMEOUT_MS).
 */
async function liveWithinBudget<T extends Record<string, unknown>>(
  live: () => Promise<BoardLiveResult<T>>,
  ms: number
): Promise<BoardLiveResult<T> | null> {
  return withinBudget(live, ms)
}

/**
 * Wall-clock ceiling for a SNAPSHOT read.
 *
 * ⚠ WHY THE FALLBACK NEEDS A BOUND OF ITS OWN. `readBoardSnapshot` cannot throw —
 * it try/catches to null — so it looked safe, and that is exactly what hid this:
 * it is UNBOUNDED, and `readBoardOrLive` calls it up to TWICE (once for the fresh
 * check, once for the stale fallback) around the 8s live bound. Under the pool
 * saturation this cache exists to survive, a single-row lookup can sit in an
 * acquire queue for tens of seconds, so the ladder's own worst case could exceed
 * Next's 60s per-page export budget and fail the whole production build — on a
 * page whose reads were all "bounded" as far as
 * `insights-server-pages-bound-their-reads` could see.
 *
 * ⚠ That guard is not weak: it checks the PAGE for an approved primitive, and
 * `readBoardOrLive` is one. The unbounded leg was INSIDE the primitive, a level
 * below anywhere the guard looks — the same guard-scope shape this repo keeps
 * paying for. With this, the ladder's worst case is 3 + 8 + 3 = 14s.
 *
 * 3s is deliberately generous for a single-row `maybeSingle()` on a table with one
 * row per board: if it has not answered in 3s we are in exactly the saturation the
 * stale rung is for, and waiting longer buys a fresher answer at the price of the
 * whole build.
 */
export const BOARD_SNAPSHOT_TIMEOUT_MS = 3_000

/** Shared race. Resolves `null` on failure OR on exceeding the budget, so a slow
 *  path and a broken path collapse into one branch — the property the live bound
 *  was added for, now available to every leg of the ladder. */
async function withinBudget<T>(run: () => Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Catch INSIDE, so the raced promise can never reject — an abandoned query that
  // fails later would otherwise surface as an unhandled rejection long after we
  // stopped listening.
  const attempt = (async () => {
    try {
      return await run()
    } catch {
      return null
    }
  })()
  try {
    return await Promise.race([
      attempt,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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
  live: () => Promise<BoardLiveResult<T>>,
  timeoutMs: number = BOARD_LIVE_TIMEOUT_MS
): Promise<{ payload: T; source: BoardSource }> {
  // ⚠ BOUNDED. See BOARD_SNAPSHOT_TIMEOUT_MS: this leg cannot throw but it can
  // HANG, and it runs before the live bound gets a say. An unbounded fresh-check
  // is the ladder's own worst case, not the live query's.
  const fresh = await withinBudget(() => readBoardSnapshot(key), BOARD_SNAPSHOT_TIMEOUT_MS)
  if (fresh && !fresh.stale) {
    return { payload: withCacheMeta(fresh.payload, fresh) as T, source: "fresh-cache" }
  }

  const res = await liveWithinBudget(live, timeoutMs)
  if (res && res.ok) {
    return { payload: res.payload, source: "live" }
  }

  // Live query errored/threw — fall back to the last-good snapshot at any age.
  // ⚠ Also bounded, and this is the leg that matters most: it only runs when the
  // instance is ALREADY struggling, so it is the likeliest of the three to sit in
  // an acquire queue. A timed-out fallback degrades to `live-degraded`, which the
  // page renders with the honest notice — the outcome the ladder was built for.
  const stale =
    fresh ?? (await withinBudget(() => readBoardSnapshot(key), BOARD_SNAPSHOT_TIMEOUT_MS))
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
