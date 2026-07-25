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

import { GET } from "@/app/api/owned-flow-ids/route"

const WALLET = "0x0000000000000001"
const get = (qs: string) => ({ nextUrl: new URL(`https://t/api/owned-flow-ids${qs}`) }) as any

beforeEach(() => {
  q.ids = ["1", "2"]; q.idsThrow = false
  q.editions = { "37:1199": true }; q.editionsThrow = false
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
  it("an editions-script failure degrades to [] (ids still returned, 200)", async () => {
    q.editionsThrow = true
    const res = await GET(get(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ids).toEqual(["1", "2"])
    expect(body.editions).toEqual([])
  })
  it("a non-TopShot collection skips the editions script (empty editions)", async () => {
    const body = await (await GET(get(`?wallet=${WALLET}&collection=nfl-all-day`))).json()
    expect(body.ids).toEqual(["1", "2"])
    expect(body.editions).toEqual([])
  })
})
