import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/owned-flow-ids (the sibling test only pins guards). Runs
// two FCL Cadence queries — the getIDs script and (TopShot only) a per-moment
// edition-key script — in parallel, tolerating an editions failure while still
// returning ids. Legs pinned: the wallet guards, the TopShot success (ids +
// editions), the ids-script failure → 500, the editions-script failure → [] (ids
// still returned), and the non-TopShot collection (editions skipped).

const q = vi.hoisted(() => ({ ids: ["1", "2"] as any, idsThrow: false, editions: { "37:1199": true } as any, editionsThrow: false }))
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async ({ cadence }: { cadence: string }) => {
      if (cadence.includes("editions")) {
        if (q.editionsThrow) throw new Error("editions script failed")
        return q.editions
      }
      if (q.idsThrow) throw new Error("ids script failed")
      return q.ids
    },
  },
}))

const sb = vi.hoisted(() => ({ keys: ["37:1199", "90:3424"] as unknown, error: null as { message: string } | null, calls: [] as unknown[] }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: unknown) => {
      sb.calls.push({ fn, args })
      return { data: sb.error ? null : sb.keys, error: sb.error }
    },
  },
}))

import { GET } from "@/app/api/owned-flow-ids/route"

const WALLET = "0x0000000000000001"
const get = (qs: string) => ({ nextUrl: new URL(`https://t/api/owned-flow-ids${qs}`) }) as any

beforeEach(() => {
  q.ids = ["1", "2"]; q.idsThrow = false
  q.editions = { "37:1199": true }; q.editionsThrow = false
  sb.keys = ["37:1199", "90:3424"]; sb.error = null; sb.calls = []
})

describe("GET /api/owned-flow-ids", () => {
  it("400 without a wallet", async () => {
    expect((await GET(get(""))).status).toBe(400)
  })
  it("400 for a non-Flow-address wallet", async () => {
    expect((await GET(get("?wallet=notawallet"))).status).toBe(400)
  })
  it("TopShot: returns ids + count + deduped edition keys", async () => {
    const body = await (await GET(get(`?wallet=${WALLET}`))).json()
    expect(body.wallet).toBe(WALLET)
    expect(body.ids).toEqual(["1", "2"])
    expect(body.count).toBe(2)
    expect(body.editions).toEqual(["37:1199"])
  })
  it("coerces non-string ids to strings and defaults non-array results to []", async () => {
    q.ids = [1, 2, 3]
    const body = await (await GET(get(`?wallet=${WALLET}`))).json()
    expect(body.ids).toEqual(["1", "2", "3"])
  })
  it("an ids-script failure → 500", async () => {
    q.idsThrow = true
    const res = await GET(get(`?wallet=${WALLET}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("Failed to fetch owned IDs")
  })
  it("a healthy chain read is source 'chain', complete, cacheable, and never touches the snapshot", async () => {
    const res = await GET(get(`?wallet=${WALLET}`))
    const body = await res.json()
    expect(body.editions_source).toBe("chain")
    expect(body.editions_complete).toBe(true)
    expect(res.headers.get("cache-control")).toContain("max-age=600")
    expect(sb.calls).toHaveLength(0)
  })
  it("an editions-script failure falls back to the wallet's synced snapshot (source 'cache', ids still returned, 200)", async () => {
    // 2026-09-24: the per-moment script dies at Flow's 100k computation limit
    // on a large collection; this used to answer editions: [] under
    // max-age=600 — "owns nothing", cached for 10 minutes.
    q.editionsThrow = true
    const res = await GET(get(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ids).toEqual(["1", "2"])
    expect(body.editions).toEqual(["37:1199", "90:3424"])
    expect(body.editions_source).toBe("cache")
    expect(body.editions_complete).toBe(true)
    expect(sb.calls[0]).toMatchObject({ fn: "get_wallet_owned_edition_keys", args: { p_wallet: WALLET, p_collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd" } })
  })
  it("when the chain AND the snapshot fail, the empty list is marked incomplete and is not cacheable", async () => {
    q.editionsThrow = true
    sb.error = { message: "statement timeout" }
    const res = await GET(get(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editions).toEqual([])
    expect(body.editions_source).toBe("none")
    expect(body.editions_complete).toBe(false)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
  it("a named collection with no Flow contract is refused — never the Top Shot walk under its name (2026-09-26)", async () => {
    for (const c of ["candy-mlb", "panini-blockchain", "bogus"]) {
      const res = await GET(get(`?wallet=${WALLET}&collection=${c}`))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ids).toBeUndefined()
      expect(String(body.error)).toContain(c)
    }
  })
  it("a non-TopShot collection skips the editions script (empty editions)", async () => {
    const body = await (await GET(get(`?wallet=${WALLET}&collection=nfl-all-day`))).json()
    expect(body.ids).toEqual(["1", "2"])
    expect(body.editions).toEqual([])
  })
})
