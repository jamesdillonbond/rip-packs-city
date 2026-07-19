import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"
import { GET_OWNED_MOMENT_IDS } from "@/lib/chains/flow/allday-cadence"

// Route integration test for POST /api/allday-wallet-search.
// The body is validated by a zod schema; an invalid/empty input 400s (with an
// empty rows/summary shell) before any Cadence walk. We ALSO drive the 2xx
// success path: fcl.query is dispatched by cadence script (owned-ids -> [123];
// metadata -> a fixed record) and the getMintedMoment GQL is inert, so a valid
// 0x wallet resolves directly and yields one shaped moment row. FMV enrichment
// reads an empty editions set (Supabase stub in vi.hoisted) and no-ops.

const h = vi.hoisted(() => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    in: () => sb,
    order: () => sb,
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return { sb }
})

vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async ({ cadence }: any) =>
      cadence === GET_OWNED_MOMENT_IDS
        ? [123]
        : {
            player: "Josh Allen",
            team: "BUF",
            setName: "Base Set",
            setID: "1",
            playID: "2",
            serial: "5",
            mint: "100",
            series: "S1",
            tier: "COMMON",
          },
  },
}))
vi.mock("@/lib/chains/flow/allday", () => ({ alldayGraphql: async () => ({}) }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))

import { POST } from "@/app/api/allday-wallet-search/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-wallet-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/allday-wallet-search", () => {
  it("400s on an empty/invalid body", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.summary.totalMoments).toBe(0)
  })

  it("200s and returns a shaped moment row for a valid wallet", async () => {
    const res = await POST(req({ input: "0xabcdef0123456789" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.totalMoments).toBe(1)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].playerName).toBe("Josh Allen")
    expect(body.rows[0].editionKey).toBe("1:2")
  })
})
