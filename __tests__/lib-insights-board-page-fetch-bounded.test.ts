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

describe("withPagedBoardBudget — the fetchAllPaged flavour RESOLVES, never rejects", () => {
  it("passes a fast paged read straight through", async () => {
    const { withPagedBoardBudget } = await import("@/lib/insights/board-page-fetch")
    const res = await withPagedBoardBudget(
      new Promise<{ rows: number[]; error: string | null }>((r) =>
        setTimeout(() => r({ rows: [1, 2], error: null }), 5),
      ),
      "board",
      200,
    )
    expect(res).toEqual({ rows: [1, 2], error: null })
  })

  it("turns an overrun into an ERROR STRING, not a rejection", async () => {
    // ⚠ THE WHOLE REASON THIS EXISTS. The paged pages have an `if (error)`
    // degraded branch and NO try/catch, so a rejection would escape and throw
    // during the static export — failing the build just as surely as the hang it
    // replaces, only faster and with a more confusing message.
    const { withPagedBoardBudget } = await import("@/lib/insights/board-page-fetch")
    const res = await withPagedBoardBudget(
      new Promise<{ rows: number[]; error: string | null }>(() => {}),
      "board",
      20,
    )
    expect(res.rows).toEqual([])
    expect(res.error).toMatch(/exceeded 20ms/)
  })

  it("does not reject even when the underlying read rejects", async () => {
    // Belt and braces: the caller has no catch, so a rejecting source must not
    // become an unhandled throw at prerender time either.
    const { withPagedBoardBudget } = await import("@/lib/insights/board-page-fetch")
    await expect(
      withPagedBoardBudget(
        Promise.reject(new Error("ECONNRESET")),
        "board",
        200,
      ),
    ).rejects.toThrow("ECONNRESET")
  })
})

describe("the budget timer is cleared, not leaked", () => {
  // ⚠ NOT observable from a return value — a leaked timer changes nothing a
  // caller can see, so removing the `finally` SURVIVED every assertion above.
  // During a static export a pending 8s timer keeps the event loop alive, which
  // would turn a bound meant to make the build faster into a source of delay on
  // every fast board. Spying on clearTimeout is what makes the `finally` load-
  // bearing.
  it("clears the timer when the read wins the race", async () => {
    const { withBoardBudget } = await import("@/lib/insights/board-page-fetch")
    const spy = vi.spyOn(globalThis, "clearTimeout")
    try {
      await withBoardBudget(
        new Promise<string>((r) => setTimeout(() => r("fast"), 5)),
        "board",
        5_000,
      )
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("clears the timer on the paged flavour too", async () => {
    const { withPagedBoardBudget } = await import("@/lib/insights/board-page-fetch")
    const spy = vi.spyOn(globalThis, "clearTimeout")
    try {
      await withPagedBoardBudget(
        new Promise<{ rows: number[]; error: string | null }>((r) =>
          setTimeout(() => r({ rows: [], error: null }), 5),
        ),
        "board",
        5_000,
      )
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
