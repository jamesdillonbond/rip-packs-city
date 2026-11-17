import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"

// Route-integration test for /api/cron/populate-pinnacle-wmc-fmv.
// Auth: Bearer INGEST_SECRET_TOKEN (module-const TOKEN, fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: the handler authenticates synchronously, defers the FMV RPC +
// log_pipeline_run into after() (stubbed no-op), and returns an immediate 202
// accept — observable without any Supabase I/O.

// after() is stubbed so the deferred populate_pinnacle_wmc_fmv RPC never runs.
const cap = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { cap.fn = fn } }
})
const pst = vi.hoisted(() => ({
  populate: { data: { examined: 100, updated: 40 } as any, error: null as any },
  populateThrows: false,
  logThrows: false,
  runs: [] as any[],
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({}),
    rpc: async (name: string, args: any) => {
      if (name === "log_pipeline_run") {
        if (pst.logThrows) throw new Error("log down")
        pst.runs.push(args)
        return { data: null, error: null }
      }
      if (pst.populateThrows) throw new Error("populate exploded")
      return pst.populate
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/populate-pinnacle-wmc-fmv/route")
})

describe("POST /api/cron/populate-pinnacle-wmc-fmv", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/populate-pinnacle-wmc-fmv — success path (immediate 202 accept)", () => {
  it("202s and reports the pipeline accept with the correct bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("populate-pinnacle-wmc-fmv")
    expect(typeof body.started_at).toBe("string")
  })
})

// --- the after() body: the FMV populate + its pipeline_runs accounting ---

describe("POST /api/cron/populate-pinnacle-wmc-fmv — deferred populate", () => {
  async function accept() {
    pst.runs = []
    cap.fn = null
    await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(cap.fn).toBeTypeOf("function")
    await cap.fn!()
    return pst.runs[0]
  }

  beforeEach(() => {
    pst.populate = { data: { examined: 100, updated: 40 }, error: null }
    pst.populateThrows = false
    pst.logThrows = false
  })

  it("logs examined/updated and derives rows_skipped from the difference", async () => {
    const run = await accept()
    expect(run.p_pipeline).toBe("populate-pinnacle-wmc-fmv")
    expect(run.p_ok).toBe(true)
    expect(run.p_rows_found).toBe(100)
    expect(run.p_rows_written).toBe(40)
    expect(run.p_rows_skipped).toBe(60)
    expect(run.p_collection_slug).toBe("disney_pinnacle")
    expect(run.p_extra.limit).toBe(10000)
  })

  it("never reports a negative rows_skipped when updated exceeds examined", async () => {
    pst.populate = { data: { examined: 5, updated: 9 }, error: null }
    expect((await accept()).p_rows_skipped).toBe(0)
  })

  it("coerces missing / non-numeric RPC counters to 0", async () => {
    pst.populate = { data: { examined: "abc" }, error: null }
    const run = await accept()
    expect(run.p_rows_found).toBe(0)
    expect(run.p_rows_written).toBe(0)
  })

  it("logs ok:false with the message when the populate RPC errors", async () => {
    pst.populate = { data: null, error: { message: "populate failed" } }
    const run = await accept()
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toBe("populate failed")
    expect(run.p_rows_written).toBe(0)
  })

  it("logs ok:false when the populate RPC throws", async () => {
    pst.populateThrows = true
    const run = await accept()
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toBe("populate exploded")
  })

  it("swallows a log_pipeline_run failure without escaping after()", async () => {
    pst.logThrows = true
    cap.fn = null
    await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })
})
