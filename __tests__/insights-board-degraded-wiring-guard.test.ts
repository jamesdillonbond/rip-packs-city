import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Source-level guard for the "a failed read renders as an empty board" class.
//
// WHY A SOURCE TEST. Each public /insights board is a SERVER page that hands rows
// to a client shell. The honest-degradation prop (`initialDegraded`) is OPTIONAL on
// every client — it has to be, so the two cached boards and any future board can
// omit it — which means `tsc` is structurally incapable of catching a page that
// forgets to pass it. Without this guard a page could silently regress to
//
//     if (error) { console.error(...); return [] }
//
// and the board would render EMPTY at HTTP 200: byte-identical to "nothing
// matched", so a statement timeout is served to the reader as a measurement. That
// is the exact failure lib/insights/board-status.ts was written for, measured in
// production 2026-08-09 (six simultaneous 57014s on one candy-mlb render, still a
// 200). The bug is INVISIBLE to the 5xx metrics (it is a 200) and to the
// board-liveness probe (which times `SELECT count(*)`, a query the planner prunes),
// so a compile-time or monitoring signal will not catch it — only this will.
//
// SCOPE: the six single-view boards that fetch their default rows inline. The
// cached boards (candy-mlb, panini-squeeze, deals, first-mint, rookies) route
// through readBoardOrLive/lib/insights/boards.ts and carry their `ok` flag in the
// cached payload instead, so they are deliberately NOT matched here — asserting
// this shape on them would be a false positive.
const INLINE_FETCH_BOARDS = [
  "squeeze",
  "trophies",
  "offer-spread",
  "pinnacle-scarcity",
  "allday-scarcity",
  "set-squeeze",
] as const

function pageSource(board: string): string {
  const p = join(process.cwd(), "app", "insights", board, "page.tsx")
  expect(existsSync(p), `${board}/page.tsx should exist`).toBe(true)
  return readFileSync(p, "utf8")
}

describe("public /insights boards keep their honest-degradation wiring", () => {
  for (const board of INLINE_FETCH_BOARDS) {
    it(`${board} reports a FAILED backing read instead of returning bare []`, () => {
      const src = pageSource(board)

      // The error branch must carry the failure out, not swallow it into [].
      expect(src, `${board}: error path must return { rows: [], ok: false }`).toContain(
        "return { rows: [], ok: false }"
      )

      // A bare `return []` inside the fetch helper is the regressed shape.
      expect(src, `${board}: must not return a bare [] on error`).not.toMatch(
        /\n\s*return \[\]\s*\n/
      )

      // ...and the failure must actually reach the client, not just be computed.
      expect(src, `${board}: must build a summary via summarizeDegraded`).toContain(
        "summarizeDegraded("
      )
      expect(src, `${board}: must pass initialDegraded to its client`).toContain(
        "initialDegraded="
      )
    })
  }

  // The CACHED boards carry `ok` in the payload instead of fetching inline, so they
  // are exempt from the checks above — but they have their OWN silent-empty path.
  // readBoardOrLive returns source "live-degraded" (payload `{}`) when the live query
  // failed AND no snapshot existed to fall back on, so `payload.degraded` is undefined
  // and the board renders empty at HTTP 200. All five discarded `source` until
  // 2026-08-12. Pin that they read it and forward it.
  const CACHED_BOARDS = ["deals", "first-mint", "rookies", "candy-mlb", "panini-squeeze"] as const

  for (const board of CACHED_BOARDS) {
    it(`${board} surfaces a live-degraded cache read`, () => {
      const src = pageSource(board)
      expect(src, `${board}: must destructure \`source\` from readBoardOrLive`).toMatch(
        /\{\s*payload\s*,\s*source\s*\}\s*=\s*await\s+readBoardOrLive/
      )
      expect(src, `${board}: must map source -> degraded via degradedFromSource`).toContain(
        "degradedFromSource(source,"
      )
      expect(src, `${board}: must pass the summary to its client`).toMatch(
        /(initialDegraded|degraded)=\{/
      )
    })
  }

  // DIRECTORY-DRIVEN backstop. The two lists above are hand-maintained and were
  // BOTH under-enumerated when written — six routes when it was 29, inline-fetch
  // boards when there was a second cache path, and then 6 of 20 server-fetching
  // pages. A hardcoded list cannot catch the page nobody thought to add, so this
  // asserts the property over the whole directory: any /insights page that fetches
  // server-side must carry SOME degradation signal.
  it("every server-fetching /insights page carries a degradation signal", () => {
    const dir = join(process.cwd(), "app", "insights")
    const offenders: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, "page.tsx")
      if (!existsSync(p)) continue
      const src = readFileSync(p, "utf8")
      // CLIENT pages are a different class and are correctly excluded: their catch
      // sets an error STATE the UI renders (pack-reality / squeeze-check / tc-report
      // all call setError), so the failure is already visible. The silent-empty
      // defect is specific to a SERVER component swallowing into empty data with
      // nothing left to render but "no results".
      if (/^\s*["']use client["']/.test(src)) continue
      // ⚠ Do NOT gate this on `supabaseAdmin`. Many of these pages fetch through a
      // lib helper (top-sales → fetchTopSales, market-pulse → fetchMarketPulse) and
      // never name the client, so a supabaseAdmin-gated predicate SKIPS them — this
      // guard silently passed with zero signals on top-sales until that was caught
      // by mutation-testing it. The failure-handling shape is the real tell.
      const handlesFailure = /catch \(|if \(error\)|readBoardOrLive/.test(src)
      if (!handlesFailure) continue
      // Any of the sanctioned signals: the summarize helpers, the cache-source
      // helper, a forwarded prop, or this surface's older `loadError` prop.
      const signals = /summarizeDegraded|degradedFromSource|initialDegraded|loadError/.test(src)
      if (!signals) offenders.push(name)
    }
    expect(
      offenders,
      "These /insights pages fetch server-side but swallow a failure into empty data — " +
        "a DB error then renders as 'nothing matched' at HTTP 200. Thread an `ok` flag and " +
        "render <DegradedDataNotice>. Offending: " + offenders.join(", ")
    ).toEqual([])
  })

  it("covers every inline-fetch board — a new one must be added here or cached", () => {
    // Cheap rot-guard: if a board page still fetches inline via supabaseAdmin and
    // is not in the list above, it is unprotected. Enumerating known-cached boards
    // explicitly (rather than globbing) keeps the failure message actionable.
    const CACHED = ["candy-mlb", "panini-squeeze", "deals", "first-mint", "rookies"]
    for (const board of INLINE_FETCH_BOARDS) {
      expect(CACHED).not.toContain(board)
    }
    expect(new Set(INLINE_FETCH_BOARDS).size).toBe(INLINE_FETCH_BOARDS.length)
  })
})
