import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep-drive of the refresh-special-serial-owners-mv after() body — the part the
// sibling test can't reach because it stubs after() to a no-op. The route
// deliberately fires-and-forgets the ~125s CONCURRENTLY refresh and SWALLOWS the
// expected API-gateway timeout (the SQL fn self-logs its own authoritative
// pipeline_runs row server-side). That swallow is the silent-run risk: if the
// trigger throws, the route must NOT surface it (it already 202'd) and must NOT
// write a duplicate/contradicting log row. Here we capture the after() fn and
// invoke it directly against a spy RPC.

const h = vi.hoisted(() => ({
  afterFns: [] as Array<() => any>,
  rpcCalls: [] as Array<{ name: string; args: any }>,
  rpcThrows: false,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => any) => { h.afterFns.push(fn) } }
})

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: any) => {
      h.rpcCalls.push({ name, args })
      if (h.rpcThrows) throw new Error("upstream request timeout")
      return { data: null, error: null }
    },
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"

const mod = await import("@/app/api/cron/refresh-special-serial-owners-mv/route")

beforeEach(() => {
  h.afterFns = []
  h.rpcCalls = []
  h.rpcThrows = false
})

describe("refresh-special-serial-owners-mv — after() body", () => {
  it("202-accepts then the after() body fires the CONCURRENTLY refresh RPC", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    expect(h.afterFns).toHaveLength(1)
    await h.afterFns[0]()
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].name).toBe("refresh_topshot_special_serial_owners_mv")
  })

  it("swallows a trigger throw (the SQL fn self-logs; the route already 202'd)", async () => {
    h.rpcThrows = true
    await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(h.afterFns).toHaveLength(1)
    // The after() body must resolve, not reject, even though the RPC throws.
    await expect(h.afterFns[0]()).resolves.toBeUndefined()
    expect(h.rpcCalls[0].name).toBe("refresh_topshot_special_serial_owners_mv")
  })

  it("GET is an alias of POST (same accept envelope)", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("refresh-special-serial-owners-mv")
  })
})
