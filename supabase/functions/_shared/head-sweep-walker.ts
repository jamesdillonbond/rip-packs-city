// head-sweep-walker — the generic engine behind every "newest-first index + history
// cursor" ingest lane (pack sales, pack opens).
//
// ── THE CLASS IT FIXES (2026-09-23) ────────────────────────────────────────
// A lane that resumes ONE cursor through a whole history makes a NEW row wait
// for the entire pass before it can land. Measured the same day on three lanes:
// Top Shot pack sales (mean 5.2 h behind the chain), All Day pack sales (11.1 h),
// and the Top Shot moment hydrator (a day's pulls examined only after the pass
// wrapped). Every run here reads the HEAD first and stops at the first page
// whose rows are ALL already stored; the sweep then continues behind it with
// the remaining page budget.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
// * `rows_written` counts rows that did NOT exist before this run (a key probe
//   per page), not rows offered to an upsert.
// * `ok` is derived from whether every write landed; a failed cursor write
//   fails the run and reports the cursor where it WAS (R123).
// * A walk that stops on an error sets `partial` — the rows stored so far are a
//   partial page set, never presented as a complete one.
// * `head_budget_exhausted` (#135, 2026-09-24): the head used all `headPages`
//   and its last page was ALL new rows (it never reached a stored one), so rows between the head budget
//   and what an earlier run stored may be missing. When the sweep is latched
//   `done`, nothing else would ever walk that gap, so the walker unlatches it
//   (cursor → start, done=false) and the NEXT run's sweep re-walks from the
//   head (`sweep_unlatched`). Mid-sweep it is reported only: resetting there
//   would throw away sweep progress, and the lane's timer unlatch covers it.

export type Page<T> = {
  totalCount: number | null
  endCursor: string | null
  hasNextPage: boolean
  rows: T[]
}

export type PageFetch<T> = { ok: true; page: Page<T> } | { ok: false; error: string }

export type HeadSweepDeps<T> = {
  fetchPage: (after: string | null) => Promise<PageFetch<T>>
  /** The row's primary-key string (what existingKeys returns). */
  keyOf: (row: T) => string
  /** Returns the subset of keys already stored, or an error. */
  existingKeys: (rows: T[]) => Promise<{ keys: Set<string>; error: string | null }>
  upsert: (rows: T[]) => Promise<string | null>
  readCursor: () => Promise<{ after: string | null; done: boolean; error: string | null }>
  writeCursor: (after: string | null, done: boolean, totalSeen: number | null) => Promise<string | null>
  /** The time a row describes (block_time / opened_at), for telemetry only. */
  timeOf?: (row: T) => string | null
  sleep?: (ms: number) => Promise<void>
}

export type HeadSweepResult = {
  ok: boolean
  error: string | null
  head_pages: number
  head_new: number
  sweep_pages: number
  sweep_new: number
  sweep_skipped_done: boolean
  rows_found: number
  rows_written: number
  newest_block_time: string | null
  oldest_sweep_block_time: string | null
  cursor_before: string | null
  cursor_after: string | null
  sweep_has_next: boolean | null
  total_api: number | null
  /** true when a walk stopped on an error: the rows stored so far are a PARTIAL page set. */
  partial: boolean
  /** The head spent its whole page budget without reaching a stored row (a gap may exist behind it). */
  head_budget_exhausted: boolean
  /** A latched sweep was reset because the head budget ran out; the next run re-walks from the head. */
  sweep_unlatched: boolean
}

/**
 * Head-walk stop rule. Keep reading toward the past while the page still
 * brought NEW rows and the API says there is more. A page of only-known rows
 * means we have reached what an earlier run stored.
 */
export function shouldContinueHead(newOnPage: number, pageRows: number, hasNextPage: boolean): boolean {
  if (!hasNextPage) return false
  if (pageRows === 0) return false
  return newOnPage > 0
}

/** Store one page: probe the keys for what is new, upsert all. */
async function storePage<T>(deps: HeadSweepDeps<T>, rows: T[]): Promise<{ newCount: number; error: string | null }> {
  if (rows.length === 0) return { newCount: 0, error: null }
  const ex = await deps.existingKeys(rows)
  if (ex.error) return { newCount: 0, error: "probe: " + ex.error }
  const newCount = rows.filter((r) => !ex.keys.has(deps.keyOf(r))).length
  const upErr = await deps.upsert(rows)
  if (upErr) return { newCount: 0, error: "upsert: " + upErr }
  return { newCount, error: null }
}

export async function runHeadSweepWalk<T>(
  deps: HeadSweepDeps<T>,
  opts: { headPages: number; totalPages: number; reset: boolean },
): Promise<HeadSweepResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeOf = deps.timeOf ?? (() => null)
  const res: HeadSweepResult = {
    ok: false, error: null, head_pages: 0, head_new: 0, sweep_pages: 0, sweep_new: 0,
    sweep_skipped_done: false, rows_found: 0, rows_written: 0, newest_block_time: null,
    oldest_sweep_block_time: null, cursor_before: null, cursor_after: null, sweep_has_next: null,
    total_api: null, partial: false, head_budget_exhausted: false, sweep_unlatched: false,
  }

  // ── 1. HEAD: newest first, until a page brings nothing new ──────────────
  let headAfter: string | null = null
  for (let i = 0; i < opts.headPages; i++) {
    const r = await deps.fetchPage(headAfter)
    if (!r.ok) { res.error = "head fetch: " + r.error; res.partial = true; break }
    res.head_pages++
    res.total_api = r.page.totalCount ?? res.total_api
    if (i === 0 && r.page.rows.length) res.newest_block_time = timeOf(r.page.rows[0])
    const s = await storePage(deps, r.page.rows)
    if (s.error) { res.error = "head " + s.error; res.partial = true; break }
    res.rows_found += r.page.rows.length
    res.head_new += s.newCount
    if (!shouldContinueHead(s.newCount, r.page.rows.length, r.page.hasNextPage)) break
    // Last page of the budget and not one of its rows was already stored: the
    // head never reached earlier-run territory, so a gap may sit behind it.
    if (i === opts.headPages - 1) {
      res.head_budget_exhausted = s.newCount === r.page.rows.length
      break
    }
    headAfter = r.page.endCursor
    await sleep(120)
  }

  // ── 2. SWEEP: resume the history cursor with the remaining budget ───────
  if (!res.error) {
    const c = await deps.readCursor()
    if (c.error) {
      res.error = "cursor read: " + c.error
    } else if (c.done && !opts.reset) {
      res.sweep_skipped_done = true
      res.cursor_before = c.after
      res.cursor_after = c.after
      if (res.head_budget_exhausted) {
        const wErr = await deps.writeCursor(null, false, res.total_api)
        if (wErr) {
          res.error = "cursor unlatch: " + wErr // the cursor is where it WAS (still latched)
        } else {
          res.sweep_unlatched = true
          res.cursor_after = null
        }
      }
    } else {
      let after: string | null = opts.reset ? null : c.after
      res.cursor_before = after
      let hasNext = true
      const budget = Math.max(0, opts.totalPages - res.head_pages)
      for (; res.sweep_pages < budget && hasNext; ) {
        const r = await deps.fetchPage(after)
        if (!r.ok) { res.error = "sweep fetch: " + r.error; res.partial = true; break }
        res.sweep_pages++
        res.total_api = r.page.totalCount ?? res.total_api
        const s = await storePage(deps, r.page.rows)
        if (s.error) { res.error = "sweep " + s.error; res.partial = true; break }
        res.rows_found += r.page.rows.length
        res.sweep_new += s.newCount
        const last = r.page.rows[r.page.rows.length - 1]
        const lt = last ? timeOf(last) : null
        if (lt) res.oldest_sweep_block_time = lt
        hasNext = r.page.hasNextPage
        after = r.page.endCursor ?? after
        await sleep(120)
      }
      res.sweep_has_next = hasNext
      // Persist progress even after a mid-sweep error: `after` only ever
      // advanced past pages that were stored. `done` only on a clean end.
      const wErr = await deps.writeCursor(after, !hasNext && !res.error, res.total_api)
      if (wErr) {
        res.error = (res.error ? res.error + "; " : "") + "cursor write: " + wErr
        res.cursor_after = res.cursor_before // the cursor is where it WAS
      } else {
        res.cursor_after = after
      }
    }
  }

  res.rows_written = res.head_new + res.sweep_new
  res.ok = res.error === null
  return res
}

/** Log a walk to pipeline_runs. Returns the log error (never swallowed by the caller). */
export async function logHeadSweep(
  sb: any,
  cfg: { pipeline: string; collectionSlug: string },
  startedAt: string,
  r: HeadSweepResult,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  const { error } = await sb.rpc("log_pipeline_run", {
    p_pipeline: cfg.pipeline,
    p_started_at: startedAt,
    p_rows_found: r.rows_found,
    p_rows_written: r.rows_written,
    p_rows_skipped: r.rows_found - r.rows_written,
    p_ok: r.ok,
    p_error: r.error,
    p_collection_slug: cfg.collectionSlug,
    p_cursor_before: r.cursor_before,
    p_cursor_after: r.cursor_after,
    p_extra: {
      head_pages: r.head_pages, head_new: r.head_new, sweep_pages: r.sweep_pages, sweep_new: r.sweep_new,
      sweep_skipped_done: r.sweep_skipped_done, sweep_has_next: r.sweep_has_next,
      newest_block_time: r.newest_block_time, oldest_sweep_block_time: r.oldest_sweep_block_time,
      total_api: r.total_api, partial: r.partial,
      head_budget_exhausted: r.head_budget_exhausted, sweep_unlatched: r.sweep_unlatched, ...extra,
    },
  })
  return error ? error.message : null
}

/** Gate on ?key=, failing CLOSED when the secret is unset. Returns a Response to send, or null to proceed. */
export function checkGate(url: URL, gate: { key: string; keyOld: string }): Response | null {
  if (!gate.key) return new Response("gate not configured", { status: 500 })
  const k = url.searchParams.get("key")
  if (k !== gate.key && !(gate.keyOld && k === gate.keyOld)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
  }
  return null
}

/** Dapper studio GraphQL POST with bounded retries on 429/5xx/network. */
export async function studioGql(
  query: string,
  variables: unknown,
  headers: Record<string, string>,
  endpoint = "https://api.production.studio-platform.dapperlabs.com/graphql",
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      })
      if (!r.ok) {
        if ((r.status === 429 || r.status >= 500) && attempt < 4) {
          await new Promise((s) => setTimeout(s, 1000 * attempt))
          continue
        }
        return { ok: false, error: `HTTP ${r.status}` }
      }
      const j = await r.json()
      if (j.errors?.length) return { ok: false, error: String(j.errors[0].message) }
      return { ok: true, data: j.data }
    } catch (e) {
      if (attempt < 4) {
        await new Promise((s) => setTimeout(s, 1000 * attempt))
        continue
      }
      return { ok: false, error: String(e) }
    }
  }
  return { ok: false, error: "retries exhausted" }
}
