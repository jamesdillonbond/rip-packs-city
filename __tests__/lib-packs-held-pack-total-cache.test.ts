import { describe, it, expect } from "vitest"
import { CACHE_FRESH_MS, CACHE_STALE_OK_MS, pickHeldValue, readHeldPackTotal } from "@/lib/packs/held-pack-total"

// wallet_pack_value_cache (2026-11-22, inbox 2026-11-22T0440Z): the biggest pack wallets take ~19 s
// and hit the function's 20 s ceiling. Pins: a fresh cache row is served without a live read; a
// stale row is refreshed live and the success is written back; a failed live read falls back to a
// row up to 24 h old; older than that, or no row, the wallet is a failed read — never $0.

const NOW = Date.parse("2026-11-22T17:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const V = (usd: number) => ({ count: 2, listed_count: 2, floor_ask_usd: usd, capped_ask_count: 2, capped_ask_usd: usd, unreferenced_ask_count: 0 })

function fakeSb(cacheRows: unknown[], live: Record<string, unknown>) {
  const upserts: unknown[] = []
  const rpcs: string[] = []
  const sb = {
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: cacheRows, error: null }) }),
      upsert: (row: unknown) => { upserts.push(row); return Promise.resolve({ error: null }) },
    }),
    rpc: (_f: string, a: { p_wallet: string }) => {
      rpcs.push(a.p_wallet)
      const r = live[a.p_wallet]
      return Promise.resolve(r === undefined ? { data: null, error: { message: "57014" } } : { data: r, error: null })
    },
  }
  return { sb, upserts, rpcs }
}

describe("pickHeldValue", () => {
  const row = (age: number) => ({ wallet_addr: "w", value: V(10), computed_at: ago(age) })
  it("serves a fresh row without a live read, never a stale one", () => {
    expect(pickHeldValue(row(CACHE_FRESH_MS - 1000), "skipped", NOW)).toEqual(V(10))
    expect(pickHeldValue(row(CACHE_FRESH_MS + 1000), "skipped", NOW)).toBeNull()
    expect(pickHeldValue(undefined, "skipped", NOW)).toBeNull()
  })
  it("prefers a live answer; on a failed live read falls back up to 24 h, then gives up", () => {
    expect(pickHeldValue(row(CACHE_FRESH_MS + 1000), V(12), NOW)).toEqual(V(12))
    expect(pickHeldValue(row(CACHE_STALE_OK_MS - 1000), null, NOW)).toEqual(V(10))
    expect(pickHeldValue(row(CACHE_STALE_OK_MS + 1000), null, NOW)).toBeNull()
  })
})

describe("readHeldPackTotal with the cache", () => {
  it("fresh row: no live read; stale row: live read + write-back; failed live: stale fallback; nothing: failed", async () => {
    const { sb, upserts, rpcs } = fakeSb([
      { wallet_addr: "0xfresh", value: V(100), computed_at: ago(5 * 60 * 1000) },
      { wallet_addr: "0xstale", value: V(50), computed_at: ago(2 * 3600 * 1000) },
      { wallet_addr: "0xwhale", value: V(20000), computed_at: ago(3 * 3600 * 1000) },
      { wallet_addr: "0xjunk", value: null, computed_at: "not a date" },
    ], { "0xstale": V(60) })
    const t = await readHeldPackTotal(sb, ["0xfresh", "0xstale", "0xwhale", "0xnone", "0xjunk"], "test", NOW)
    expect(rpcs.sort()).toEqual(["0xjunk", "0xnone", "0xstale", "0xwhale"])
    expect(upserts).toEqual([{ wallet_addr: "0xstale", value: V(60), computed_at: new Date(NOW).toISOString() }])
    expect(t).toEqual({ held: 6, listed: 6, lowAskUsd: 20160, unpriced: 0, walletsFailed: 2, byWallet: { "0xnone": null, "0xjunk": null } })
  })
  it("a failed cache read is an empty cache, not an error", async () => {
    const sb = {
      from: () => ({ select: () => ({ in: () => Promise.reject(new Error("cache down")) }), upsert: () => Promise.reject(new Error("x")) }),
      rpc: () => Promise.resolve({ data: V(5), error: null }),
    }
    expect(await readHeldPackTotal(sb, ["0xa"], "test", NOW)).toEqual({ held: 2, listed: 2, lowAskUsd: 5, unpriced: 0, walletsFailed: 0, byWallet: {} })
  })
})

describe("readHeldPackTotal per-collection split (2026-11-25)", () => {
  it("keys each wallet's split by address; a failed wallet is null, a pre-split answer is absent", async () => {
    const split = { ...V(30), by_collection: { "ts-uuid": { packs: 2, capped_ask_n: 2, capped_ask_usd: 30 } } }
    const { sb } = fakeSb([
      { wallet_addr: "0xold", value: V(5), computed_at: new Date(NOW - 60 * 1000).toISOString() },
    ], { "0xnew": split })
    const t = await readHeldPackTotal(sb, ["0xnew", "0xold", "0xdead"], "test", NOW)
    expect(t.byWallet).toEqual({ "0xnew": { "ts-uuid": { packs: 2, listed: 2, usd: 30 } }, "0xdead": null })
  })
})
