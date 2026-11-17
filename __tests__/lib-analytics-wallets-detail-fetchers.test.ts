import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
  loadWallet,
  loadPositionTransfers,
  lookupUsername,
  FLOW_ADDR_RE,
  WALLET_DETAIL_TIMEOUT_MS,
} from "@/lib/analytics/wallets/detail-fetchers"

// The three reads behind /analytics/wallets/[address], now that they live in
// lib/ and a gate can see them.
//
// ── WHY THESE EXIST ────────────────────────────────────────────────────────
// The page returned a bare `null` from all three loaders for BOTH "no such
// wallet" and "the RPC failed", and answered `notFound()`. The page is
// explicitly SEO-indexable and served under ISR with `revalidate = 600`, so one
// statement timeout did not 404 a single request — it CACHED that 404 for ten
// minutes, for every visitor and every crawler, while `generateMetadata`
// published "Wallet not found" beside it.
//
// ⚠ A SOURCE SWEEP IS NOT ENOUGH HERE, and this suite exists because of a
// mutation that PROVED it. __tests__/server-pages-error-vs-absent-sweep.test.ts
// bans the bad SHAPE, so it catches a loader that reverts to `return null`. It
// does NOT catch a loader that keeps the `{ data, ok }` shape and returns the
// WRONG ok — flipping this file's error branch from `ok: false` to `ok: true`
// left every source guard green while restoring the original defect exactly.
// Semantics need a behavioural test; only shapes can be grepped.

const ADDR = "0x1234567890abcdef"

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** rpcWithRetry calls `db.rpc(fn, args)`; a bare async fn with no `.abortSignal`
 *  is the shape every mock in this repo uses. */
function db(impl: () => unknown) {
  return { rpc: () => impl() }
}

describe("FLOW_ADDR_RE", () => {
  it("accepts a canonical Flow address and rejects the near-misses a crawler invents", () => {
    expect(FLOW_ADDR_RE.test(ADDR)).toBe(true)
    for (const bad of ["", "0x", "0xZZZZ567890abcdef", ADDR.slice(0, -1), `${ADDR}0`, "vaultname"]) {
      expect(FLOW_ADDR_RE.test(bad), `${bad} must not pass`).toBe(false)
    }
  })
})

describe("loadWallet — error is not absence", () => {
  it("a malformed address is an ANSWER (ok:true), not a failure", async () => {
    // ⚠ Deliberate, and it mirrors the sets sibling. Flipping this to ok:false
    // would put a permanent "didn't load" card on every bad URL a crawler
    // invents, instead of the honest 404 those deserve.
    const res = await loadWallet("not-an-address", db(() => {
      throw new Error("must not be reached")
    }))
    expect(res).toEqual({ data: null, ok: true })
  })

  it("a returned RPC error is a FAILED read (ok:false) — never an absent wallet", async () => {
    const res = await loadWallet(
      ADDR,
      db(async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }))
    )
    expect(res.ok, "a statement timeout must not read as 'no such wallet'").toBe(false)
    expect(res.data).toBeNull()
  })

  it("a THROWN transport failure is also ok:false", async () => {
    // supabase-js RETURNS postgrest errors but THROWS on a transport failure, so
    // a loader that only handles the returned shape still leaks the other.
    const res = await loadWallet(ADDR, db(async () => {
      throw new Error("fetch failed")
    }))
    expect(res).toEqual({ data: null, ok: false })
  })

  it("an upstream 'not found' IS an answer and stays ok:true", async () => {
    const res = await loadWallet(
      ADDR,
      db(async () => ({ data: null, error: { message: "function does not exist" } }))
    )
    expect(res.ok).toBe(true)
    expect(res.data).toBeNull()
  })

  it("a successful read of a wallet with NO activity stays ok:true", async () => {
    // ⚠ The other direction, and it must keep working. A wallet that genuinely
    // never borrowed or lent is an honest empty profile, not a degraded card —
    // collapsing this into ok:false would cry wolf on the system working.
    const empty = { as_borrower: null, as_lender: null }
    const res = await loadWallet(ADDR, db(async () => ({ data: empty, error: null })))
    expect(res).toEqual({ data: empty, ok: true })
  })

  it("a successful read that returns NO ROW is still ok:true — that is a real 404", async () => {
    // ⚠ ON THE BOUNDARY, deliberately. The sibling case above uses a non-null
    // empty payload, so it passes even if `ok` is derived as `data != null` —
    // that mutation survived until this case existed. Here `data` IS null, which
    // is the only fixture that separates "the read worked and there is no such
    // wallet" (→ notFound, correct) from "the read failed" (→ unavailable card).
    // Deriving ok from the data would put a "didn't load" card on every genuinely
    // absent wallet and destroy the 404 a crawler needs.
    const res = await loadWallet(ADDR, db(async () => ({ data: null, error: null })))
    expect(res).toEqual({ data: null, ok: true })
  })

  it("passes the address through as p_addr", async () => {
    const seen: unknown[] = []
    const spy = { rpc: (fn: string, args: unknown) => { seen.push([fn, args]); return Promise.resolve({ data: {}, error: null }) } }
    await loadWallet(ADDR, spy)
    expect(seen).toEqual([["flowty_analytics_wallet_detail", { p_addr: ADDR }]])
  })

  it("a read slower than the budget resolves ok:false rather than hanging", async () => {
    vi.useFakeTimers()
    // ⚠ The happy-path sibling of this case is vacuous if the mock resolves
    // immediately — Promise.race settles a resolved microtask before the
    // setTimeout macrotask ever runs, so the assertion would pass with the
    // budget set to 0. This case therefore takes REAL (fake-clock) time.
    const pending = loadWallet(ADDR, db(() => new Promise(() => {})))
    await vi.advanceTimersByTimeAsync(WALLET_DETAIL_TIMEOUT_MS + 10)
    await expect(pending).resolves.toEqual({ data: null, ok: false })
  })

  it("does not leave a timer holding the event loop open after a fast read", async () => {
    // Not observable from the return value — a leaked timer keeps the lambda
    // alive past the response. Observable only by spying on clearTimeout.
    const clear = vi.spyOn(global, "clearTimeout")
    await loadWallet(ADDR, db(async () => ({ data: {}, error: null })))
    expect(clear).toHaveBeenCalled()
  })
})

describe("loadPositionTransfers — fails independently of the primary read", () => {
  it("returns ok:false on an RPC error", async () => {
    const res = await loadPositionTransfers(
      ADDR,
      db(async () => ({ data: null, error: { message: "boom" } }))
    )
    expect(res).toEqual({ data: null, ok: false })
  })

  it("returns the rows on success", async () => {
    const rows = { transfers: [{ id: 1 }] }
    const res = await loadPositionTransfers(ADDR, db(async () => ({ data: rows, error: null })))
    expect(res).toEqual({ data: rows, ok: true })
  })

  it("a malformed address short-circuits without a round trip", async () => {
    const res = await loadPositionTransfers("nope", db(() => {
      throw new Error("must not be reached")
    }))
    expect(res).toEqual({ data: null, ok: true })
  })
})

describe("lookupUsername — a failed lookup is not an absent handle", () => {
  it("resolves a hit to a lowercased address", async () => {
    const res = await lookupUsername("rybaguy", db(async () => ({ data: ADDR.toUpperCase(), error: null })))
    expect(res).toEqual({ data: ADDR, ok: true })
  })

  it("a miss is an ANSWER (ok:true, data:null) — the caller 404s on it", async () => {
    const res = await lookupUsername("nobody", db(async () => ({ data: null, error: null })))
    expect(res).toEqual({ data: null, ok: true })
  })

  it("an RPC error is ok:false — the caller must NOT 404 a handle that resolves fine a second later", async () => {
    // ⚠ This is the subtlest of the three. The caller REDIRECTS on a hit and
    // 404s on a miss, so conflating a failed lookup with "no such handle" 404s a
    // real handle on a blip — and ISR caches that answer for ten minutes.
    const res = await lookupUsername("rybaguy", db(async () => ({ data: null, error: { message: "timeout" } })))
    expect(res).toEqual({ data: null, ok: false })
  })

  it("a non-address payload is a miss, not a crash", async () => {
    for (const junk of [42, {}, "not-an-address", null]) {
      const res = await lookupUsername("x", db(async () => ({ data: junk, error: null })))
      expect(res, `${JSON.stringify(junk)} must read as a miss`).toEqual({ data: null, ok: true })
    }
  })
})
