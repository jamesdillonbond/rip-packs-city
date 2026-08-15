import { describe, it, expect, vi, afterEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { __marker: "service-role" } }))

import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { BOARD_LIVE_TIMEOUT_MS } from "@/lib/insights/board-cache"

// `fetchBoardForPage` is the shared server-side read for eight PRERENDERED
// `/insights` board pages, and its bound is what keeps the PRODUCTION BUILD
// deterministic — not just what keeps a page honest at request time.
//
// ── THE INCIDENT THIS PINS ─────────────────────────────────────────────────
// Two production deploys ERRORed on 2026-08-15 within ten minutes, a DIFFERENT
// page each time — `/insights/market` and `/insights/market-pulse` — both with
// "Timed out acquiring connection from connection pool" during a DB saturation
// spell, both ending "Export encountered an error … exiting the build". Neither
// commit had touched those pages. Next gives each prerendered page 60s, retries
// 3×, then kills the whole build, so ANY unbounded board read is a coin flip on
// every deploy.
//
// Same class as BOARD_LIVE_TIMEOUT_MS (first-mint) and SET_DETAIL_TIMEOUT_MS
// (/analytics/sets), met a third time. The lesson those carry is the one that
// matters here: **the fallback only ran when the query ERRORED, and a query
// that is merely SLOW errors nowhere** — so the degraded path that would have
// saved the build sat one line below a query nobody was timing.

afterEach(() => {
  vi.useRealTimers()
})

describe("fetchBoardForPage — the happy path is unchanged", () => {
  it("returns the fetcher's data with ok:true", async () => {
    const res = await fetchBoardForPage("Board", [] as number[], async () => [1, 2, 3])
    expect(res).toMatchObject({ data: [1, 2, 3], ok: true })
    expect(typeof res.fetchedAt).toBe("string")
  })

  it("hands the fetcher the service-role client, so the page never imports one", async () => {
    // This is what keeps these eight pages off the server-page data-access
    // ratchet; a fetcher that received nothing would push the client back up
    // into the unmeasured `app/**/page.tsx` tree.
    let seen: unknown = null
    await fetchBoardForPage("Board", [], async (db) => {
      seen = db
      return []
    })
    expect(seen).toMatchObject({ __marker: "service-role" })
  })

  it("reports a THROWN read as ok:false and serves the caller's fallback", async () => {
    const res = await fetchBoardForPage("Board", ["fallback"], async () => {
      throw new Error("canceling statement due to statement timeout")
    })
    expect(res).toMatchObject({ data: ["fallback"], ok: false })
  })
})

describe("fetchBoardForPage — a SLOW read is as unservable as a broken one", () => {
  it("gives up at the budget rather than blocking the page or the build", async () => {
    // A read that never settles. Unbounded, this is the exact shape that parks a
    // prerender until Next kills the build; bounded, it degrades in 8s.
    const res = await fetchBoardForPage(
      "Board",
      ["fallback"],
      () => new Promise<string[]>(() => {}),
      20,
    )
    expect(res.ok).toBe(false)
    expect(res.data).toEqual(["fallback"])
  })

  it("a read that finishes inside the budget is NOT degraded", async () => {
    // ⚠ The counter-case matters: a bound that fires early would mark every
    // healthy board degraded, which is the cry-wolf outcome board-status.ts
    // warns about. This resolves on a real timer rather than immediately —
    // an instantly-resolving promise settles as a microtask before the
    // setTimeout macrotask runs, so it would pass even with the budget at 0
    // and assert nothing (the vacuous-timeout-test trap).
    const res = await fetchBoardForPage(
      "Board",
      ["fallback"],
      () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["real"]), 5)),
      200,
    )
    expect(res).toMatchObject({ data: ["real"], ok: true })
  })

  it("defaults to the shared board budget, well under Next's 60s export limit", () => {
    // Pinned as a RELATIONSHIP, not a magic number: the point of the value is
    // that it leaves the export budget room to spare, so a re-tune stays safe
    // while a careless raise past 60s reds here.
    expect(BOARD_LIVE_TIMEOUT_MS).toBeLessThan(60_000)
    expect(BOARD_LIVE_TIMEOUT_MS).toBeGreaterThan(1_000)
  })
})
