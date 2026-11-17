import { describe, it, expect, vi, beforeEach } from "vitest"

// 2026-10-10 (known-issues #88): the share card's PACKS UNOPENED figure. It is a
// counted claim about a NAMED collector on the most-shared surface, so it is
// published only when EVERY wallet's Dapper-index walk finished clean within
// 48 h and every per-wallet read answered — otherwise null ("—"), never a
// partial sum.

const calls: Array<{ url: string; body?: string }> = []
let syncRows: unknown[] | null = []
let held: Record<string, unknown> = {}

vi.mock("@/lib/og/og-fetch", () => ({
  ogFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body })
    if (url.includes("/rest/v1/pack_wallet_sync")) {
      if (syncRows == null) return new Response("boom", { status: 503 })
      return new Response(JSON.stringify(syncRows), { status: 200 })
    }
    if (url.includes("/rpc/get_wallet_pack_history")) {
      const w = JSON.parse(init?.body ?? "{}").p_wallet as string
      const v = held[w]
      if (v === "fail") return new Response("boom", { status: 500 })
      return new Response(JSON.stringify({ total_count: v }), { status: 200 })
    }
    return new Response("[]", { status: 200 })
  }),
}))

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example"
process.env.SUPABASE_SERVICE_ROLE_KEY = "k"

const NOW = Date.parse("2026-10-10T17:00:00Z")
const fresh = (wallet: string, over: Record<string, unknown> = {}) => ({
  wallet,
  last_clean_sync_at: "2026-10-10T16:17:00Z",
  completed_at: "2026-10-10T16:18:00Z",
  last_error: null,
  ...over,
})

async function load() {
  return await import("@/app/api/og/profile/[username]/route")
}

beforeEach(() => {
  calls.length = 0
  syncRows = []
  held = {}
})

describe("fetchHeldSealedPacks", () => {
  it("sums the held count across wallets when every walk is clean and fresh", async () => {
    const { fetchHeldSealedPacks } = await load()
    syncRows = [fresh("0xaaaa000000000001"), fresh("0xaaaa000000000002")]
    held = { "0xaaaa000000000001": 53, "0xaaaa000000000002": 2 }
    expect(await fetchHeldSealedPacks(["0xAAAA000000000001", "0xaaaa000000000002"], NOW)).toBe(55)
    // case-folded Flow keys, the 'held' status, one call per wallet
    const rpc = calls.filter((c) => c.url.includes("/rpc/"))
    expect(rpc.map((c) => JSON.parse(c.body!).p_wallet).sort()).toEqual(["0xaaaa000000000001", "0xaaaa000000000002"])
    expect(JSON.parse(rpc[0].body!).p_status).toBe("held")
  })

  it("a genuine zero is published as zero", async () => {
    const { fetchHeldSealedPacks } = await load()
    syncRows = [fresh("0xaaaa000000000001")]
    held = { "0xaaaa000000000001": 0 }
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001"], NOW)).toBe(0)
  })

  it("withholds when ANY wallet's walk is stale — and does not spend the per-wallet reads", async () => {
    const { fetchHeldSealedPacks } = await load()
    syncRows = [fresh("0xaaaa000000000001"), fresh("0xaaaa000000000002", { last_clean_sync_at: "2026-10-07T00:00:00Z" })]
    held = { "0xaaaa000000000001": 53, "0xaaaa000000000002": 2 }
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001", "0xaaaa000000000002"], NOW)).toBeNull()
    expect(calls.some((c) => c.url.includes("/rpc/"))).toBe(false)
  })

  it("withholds for a wallet never walked, one that errored, and one mid-walk", async () => {
    const { fetchHeldSealedPacks } = await load()
    held = { "0xaaaa000000000001": 5 }
    syncRows = []
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001"], NOW)).toBeNull()
    syncRows = [fresh("0xaaaa000000000001", { last_error: "page 3: 503" })]
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001"], NOW)).toBeNull()
    syncRows = [fresh("0xaaaa000000000001", { completed_at: "2026-10-10T16:00:00Z" })] // older than the clean start
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001"], NOW)).toBeNull()
  })

  it("never publishes a PARTIAL sum: one failed per-wallet read withholds the whole figure", async () => {
    const { fetchHeldSealedPacks } = await load()
    syncRows = [fresh("0xaaaa000000000001"), fresh("0xaaaa000000000002")]
    held = { "0xaaaa000000000001": 53, "0xaaaa000000000002": "fail" }
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001", "0xaaaa000000000002"], NOW)).toBeNull()
  })

  it("a failed sync read, or more wallets than the budget, withholds", async () => {
    const { fetchHeldSealedPacks, HELD_PACKS_MAX_WALLETS } = await load()
    syncRows = null
    expect(await fetchHeldSealedPacks(["0xaaaa000000000001"], NOW)).toBeNull()
    const many = Array.from({ length: HELD_PACKS_MAX_WALLETS + 1 }, (_, i) => `0xbbbb00000000000${i}`)
    expect(await fetchHeldSealedPacks(many, NOW)).toBeNull()
    expect(await fetchHeldSealedPacks([], NOW)).toBeNull()
  })
})

describe("statTileWidth at five tiles (TEAMS + four)", () => {
  it("wraps 3 + 2 in the 700px column", async () => {
    const { statTileWidth } = await load()
    const w = statTileWidth(5)
    expect(3 * w + 2 * 16).toBeLessThanOrEqual(700)
    expect(4 * w + 3 * 16).toBeGreaterThan(700)
  })
})
