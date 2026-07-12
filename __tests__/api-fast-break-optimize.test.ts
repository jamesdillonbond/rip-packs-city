import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/fast-break/optimize.
// The route is intentionally UNAUTHENTICATED (the wallet is the implicit
// public boundary), so there is no auth guard to pin. We cover the param
// guards (400 malformed JSON, 400 invalid body) and one mocked seam: 404 when
// the run row is missing. The optimizer fan-out past that point is pure and
// covered by lib/fast-break-optimizer.test.ts.

const state: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "gt", "gte", "lt", "limit"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { POST } from "@/app/api/fast-break/optimize/route"

const RUN_ID = "11111111-1111-4111-8111-111111111111"

const req = (body: any, opts: { bad?: boolean } = {}) =>
  ({
    headers: new Headers(),
    nextUrl: new URL("https://t/api/fast-break/optimize"),
    json: async () => {
      if (opts.bad) throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.tables = {}
  state.rpc = {}
})

describe("POST /api/fast-break/optimize", () => {
  it("400s on malformed JSON", async () => {
    const res = await POST(req(null, { bad: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s on an invalid body", async () => {
    const res = await POST(req({ walletAddr: "not-a-flow-addr" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("404s when the run is not found", async () => {
    state.tables.fast_break_runs = { single: { data: null, error: null } }
    const res = await POST(req({ walletAddr: "0xabcdef0123456789", runId: RUN_ID }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("run_not_found")
  })
})
