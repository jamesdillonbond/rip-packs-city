import { describe, it, expect } from "vitest"
import SqueezeBoardClient from "@/app/insights/squeeze/SqueezeBoardClient"
import CrossCollectionBoardClient from "@/app/insights/cross-collection/CrossCollectionBoardClient"
import { fetchRookiesDefault } from "@/lib/insights/boards"

/**
 * Register R94's owed §2 test, run 2026-10-03 as a COLD pass of the BUILT app
 * (next build + next start, every Supabase read dropped — the built-render
 * smoke's stub). All 13 boards' KPI strips rendered "—": R94 holds. The same
 * pass found four defects the SSR arms could not, each pinned here:
 *
 *   /insights/squeeze           "No editions match those filters." under the banner
 *   /insights/cross-collection  "Top 0 TS sets ranked by cohort-holder count."
 *   /insights/rookies           "Updated Oct 3, 2026, 20:11 UTC" over a dead DB
 *   /insights/candy-mlb         "Updated Oct 3, 2026, 20:10 UTC" over ten failed sections
 *
 * The last two are now also caught on every CI build by the smoke's
 * fabricated-freshness check (scripts/qa/built-render-smoke.mjs).
 * Each failure case has a NO-CHANGE control: a guard passable by deleting the
 * feature is not a guard.
 */

const FAILED = { failed: ["Squeeze board"], truncated: [], total: 1, headline: "PARTIAL DATA" }
const CLEAN = { failed: [], truncated: [], total: 1, headline: "" }

describe("squeeze: the empty state does not conclude from a failed read", () => {
  it("SSR: a failed read says it couldn't load, NOT that no editions match", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(<SqueezeBoardClient initialRows={[]} initialFetchedAt={null} initialDegraded={FAILED} />)
    expect(html).not.toMatch(/No editions match those filters/)
    expect(html).toMatch(/Squeeze board couldn.{1,8}t be loaded/)
  })

  it("SSR NO-CHANGE CONTROL: a genuinely empty board still says no editions match", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(
      <SqueezeBoardClient initialRows={[]} initialFetchedAt="2026-10-03T00:00:00Z" initialDegraded={CLEAN} />,
    )
    expect(html).toMatch(/No editions match those filters/)
    expect(html).not.toMatch(/couldn.{1,8}t be loaded/)
  })
})

describe("cross-collection: no count in prose when there are no rows", () => {
  const seed = (overlap: unknown[]) =>
    ({ meta: { fetched_at: null }, stats: null, wallets: [], ts_set_overlap: overlap }) as never

  it("SSR: a failed read does not print 'Top 0 TS sets'", async () => {
    const { renderToString } = await import("react-dom/server")
    const html = renderToString(<CrossCollectionBoardClient initial={seed([])} initialFailed />)
    expect(html.replace(/<!--.*?-->/g, "")).not.toMatch(/Top\s*0\s*TS sets/)
    expect(html).toMatch(/TS sets/)
  })

  it("SSR NO-CHANGE CONTROL: with rows, the count is still printed", async () => {
    const { renderToString } = await import("react-dom/server")
    const rows = [{ set_name: "A", cohort_holders: 3 }, { set_name: "B", cohort_holders: 2 }]
    const html = renderToString(<CrossCollectionBoardClient initial={seed(rows)} initialFailed={false} />)
    expect(html.replace(/<!--.*?-->/g, "")).toMatch(/Top 2 TS sets/)
  })
})

describe("builders: a failed read carries no freshness stamp", () => {
  const dbWith = (error: unknown) => {
    const q: any = {
      select: () => q,
      order: () => q,
      limit: async () => ({ data: error ? null : [], error }),
    }
    return { from: () => q } as never
  }

  it("rookies: fetched_at is null when the read failed", async () => {
    const res = await fetchRookiesDefault(dbWith({ message: "fetch failed" }))
    expect(res.ok).toBe(false)
    expect(res.payload.meta.fetched_at).toBeNull()
  })

  it("rookies NO-CHANGE CONTROL: a successful read is still stamped", async () => {
    const res = await fetchRookiesDefault(dbWith(null))
    expect(res.ok).toBe(true)
    expect(typeof res.payload.meta.fetched_at).toBe("string")
  })

  it("candy: the stamp is gated on the primary Market read (source pin)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("lib/insights/candy-board.ts", "utf8")
    expect(src).toMatch(/fetchedAt:\s*rows\.ok\s*\?\s*new Date\(\)\.toISOString\(\)\s*:\s*null/)
    expect(src).not.toMatch(/fetchedAt:\s*new Date\(\)\.toISOString\(\)/)
  })
})
