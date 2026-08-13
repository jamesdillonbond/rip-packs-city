import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/topshot/set-plan — the Top Shot bulk-buy
// planner ("what would it cost to complete the rest of this set at floor, and
// what's it worth?"). The route validates the setId UUID, calls the read-side
// RPC get_topshot_set_completion_plan (mocked here), and enriches each missing
// play with a value_gap + an in-product edition deep link.

const h = vi.hoisted(() => ({ rpc: async (_fn: string, _args: any) => ({ data: null as any, error: null as any }) }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (fn: string, args: any) => h.rpc(fn, args) },
}))

const { GET } = await import("@/app/api/topshot/set-plan/route")

const VALID_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function get(qs: string) {
  return new Request(`https://t/api/topshot/set-plan${qs}`) as any
}

beforeEach(() => {
  h.rpc = async () => ({ data: null, error: null })
})

describe("GET /api/topshot/set-plan — validation", () => {
  it("400s when setId is missing", async () => {
    const res = await GET(get(""))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("setId must be a set UUID")
  })

  it("400s when setId is not a UUID", async () => {
    const res = await GET(get("?setId=not-a-uuid"))
    expect(res.status).toBe(400)
  })
})

describe("GET /api/topshot/set-plan — lookup outcomes", () => {
  it("500s without publishing the RPC's message", async () => {
    h.rpc = async () => ({ data: null, error: { message: "boom" } })
    const res = await GET(get(`?setId=${VALID_UUID}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("boom")
  })

  it("404s when the plan has no set_name (set not found)", async () => {
    h.rpc = async () => ({ data: { missing: [] }, error: null })
    const res = await GET(get(`?setId=${VALID_UUID}`))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("set not found")
  })

  it("enriches missing plays with value_gap + edition_url on success", async () => {
    h.rpc = async () => ({
      data: {
        set_name: "Base Set",
        missing: [
          { external_id: "73:2785", fmv_usd: 100, low_ask: 60 },
          { external_id: "73:2786", fmv_usd: null, low_ask: 5 },
        ],
      },
      error: null,
    })
    const res = await GET(get(`?setId=${VALID_UUID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.set_name).toBe("Base Set")
    // value_gap = fmv - low_ask, rounded to cents; null when either is missing.
    expect(body.missing[0].value_gap).toBe(40)
    expect(body.missing[0].edition_url).toBe("/nba-top-shot/edition/73%3A2785")
    expect(body.missing[1].value_gap).toBeNull()
  })

  it("clamps the limit into [1,1000] and passes it to the RPC", async () => {
    let seenLimit = -1
    h.rpc = async (_fn: string, args: any) => {
      seenLimit = args.p_limit
      return { data: { set_name: "S", missing: [] }, error: null }
    }
    await GET(get(`?setId=${VALID_UUID}&limit=99999`))
    expect(seenLimit).toBe(1000)
    await GET(get(`?setId=${VALID_UUID}&limit=0`))
    expect(seenLimit).toBe(1)
  })

  it("500s on a thrown (non-Error) rejection without publishing it", async () => {
    h.rpc = async () => {
      throw new Error("network down")
    }
    const res = await GET(get(`?setId=${VALID_UUID}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("network down")
  })
})
