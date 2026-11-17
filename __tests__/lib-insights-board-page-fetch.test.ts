import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"

// The shared initial read for every /insights/** board page.
//
// Eight pages carried byte-identical copies of this try/catch, each importing
// `supabaseAdmin` purely to hand it to a fetcher that already lived in `lib/`.
// That import is what put them on the server-page data-access ratchet, and
// `app/**/page.tsx` is measured by NEITHER coverage gate — so eight copies of
// the one branch deciding whether an outage renders as a fact sat in the only
// part of the tree no gate watches. These tests are what that centralisation
// bought.

// ⚠ The spy is created INSIDE beforeEach, not at module scope. `restoreAllMocks`
// in afterEach detaches a module-scope `spyOn` from console.error, so every test
// after the first would be configuring a dead spy and asserting on 0 calls —
// while the log plainly appears in stderr. Caught here; the shape is easy to
// mistake for "the code stopped logging".
let err: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  err = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("fetchBoardForPage", () => {
  it("returns the payload with ok:true on a successful read", async () => {
    const res = await fetchBoardForPage("Rookie board", [], async () => [{ id: 1 }])
    expect(res.data).toEqual([{ id: 1 }])
    expect(res.ok).toBe(true)
  })

  it("⚠ an EMPTY successful read is still ok:true — a quiet market is a real answer", async () => {
    // The whole point of `ok`: emptiness and failure must not collapse. A board
    // that legitimately matched nothing must NOT show the degraded notice, or
    // the notice cries wolf and stops being read.
    const res = await fetchBoardForPage("Market pulse", [], async () => [])
    expect(res.data).toEqual([])
    expect(res.ok).toBe(true)
    expect(summarizeDegraded([boardStatus("Market pulse", res.ok)])).toBeNull()
  })

  it("returns the caller's fallback with ok:false when the fetcher throws", async () => {
    const EMPTY = { windows: {}, cohort: [] }
    const res = await fetchBoardForPage("New collectors", EMPTY, async () => {
      throw new Error("canceling statement due to statement timeout")
    })
    expect(res.data).toBe(EMPTY)
    expect(res.ok).toBe(false)
  })

  it("a failed read produces a degraded summary the page can render", async () => {
    // This is the contract that matters end-to-end: `ok:false` must reach
    // summarizeDegraded as something truthy, or the board renders EMPTY at
    // HTTP 200 — byte-identical to "nothing matched", which on these public
    // surfaces is a market claim.
    const res = await fetchBoardForPage("Pack drops", [], async () => {
      throw new Error("boom")
    })
    expect(summarizeDegraded([boardStatus("Pack drops", res.ok)])).toBeTruthy()
  })

  it("NEVER throws — a board page that throws renders an error boundary, not a board", async () => {
    await expect(
      fetchBoardForPage("X", [], async () => {
        throw new Error("nope")
      }),
    ).resolves.toBeDefined()
  })

  it("survives a thrown non-Error without producing 'undefined' in the log", async () => {
    const res = await fetchBoardForPage("X", [], async () => {
      throw "string failure"
    })
    expect(res.ok).toBe(false)
    expect(err).toHaveBeenCalledWith("[insights/X] initial fetch", "string failure")
  })

  it("logs under a greppable [insights/<label>] prefix", async () => {
    await fetchBoardForPage("Serial premiums", [], async () => {
      throw new Error("detail")
    })
    expect(err).toHaveBeenCalledWith("[insights/Serial premiums] initial fetch", "detail")
  })

  it("supplies a client to the fetcher — that injection is why pages need no import", async () => {
    let received: unknown = null
    await fetchBoardForPage("X", [], async (db) => {
      received = db
      return []
    })
    // The page never imports supabaseAdmin; this is where it comes from, and it
    // is the whole reason these pages left the data-access ratchet.
    expect(received).not.toBeNull()
    expect(typeof received).toBe("object")
  })

  it("stamps fetchedAt BEFORE the read, not after it completes", async () => {
    const before = Date.now()
    const res = await fetchBoardForPage("X", [], async () => {
      await new Promise((r) => setTimeout(r, 30))
      return []
    })
    // fetchedAt is when we ASKED. If it were stamped after, a slow board would
    // advertise a freshness it does not have.
    expect(Date.parse(res.fetchedAt as string)).toBeLessThan(before + 30)
  })

  it("⚠ INVERTED 2026-09-18 — returns NULL fetchedAt on a FAILED read", async () => {
    // ── This arm used to assert the OPPOSITE, and its own comment named the
    // hazard: "a caller that rendered 'updated just now' beside this without
    // checking `ok` would be making exactly the claim this module exists to
    // prevent." Deep-audit R95 found THREE callers doing precisely that, live:
    // /insights/top-sales rendered "UPDATED SEP 18, 2026, 11:32 AM PDT" — the
    // moment of load — between its own "treat as unknown, not zero" banner and
    // a strip of fabricated zeros, and /insights/rookie-board and
    // /insights/serial-premiums did the same.
    //
    // ⭐ The lesson is why this is an INVERSION and not a deletion: a policy
    // that is safe "only because every caller remembers" is not safe, it is
    // unenforced. The safety now lives in the value, so a caller cannot forget.
    // Three further boards (market-pulse, parallel-premiums, set-completers)
    // were surfaced by the compiler when `fetchedAt` became nullable — none of
    // them was named in the audit, and all three took the render clock too.
    const res = await fetchBoardForPage("X", [], async () => {
      throw new Error("fail")
    })
    expect(res.ok).toBe(false)
    expect(res.fetchedAt).toBeNull()
  })

  it("NO-CHANGE CONTROL — a SUCCESSFUL read still carries a real stamp", async () => {
    // Without this, "return null always" passes the arm above and destroys the
    // freshness stamp on every healthy board to hide the dishonest one.
    const res = await fetchBoardForPage("X", [], async () => [])
    expect(res.ok).toBe(true)
    expect(typeof res.fetchedAt).toBe("string")
    expect(Number.isFinite(Date.parse(res.fetchedAt as string))).toBe(true)
  })

  it("passes the fallback through by reference, not a copy", async () => {
    // Pages pass shared EMPTY_BOARD constants; cloning would break identity
    // checks a client might do and would silently allocate per request.
    const EMPTY: unknown[] = []
    const res = await fetchBoardForPage("X", EMPTY, async () => {
      throw new Error("fail")
    })
    expect(res.data).toBe(EMPTY)
  })
})
