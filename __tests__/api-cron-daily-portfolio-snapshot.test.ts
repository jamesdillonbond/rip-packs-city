import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/daily-portfolio-snapshot (+ POST alias).
// Fail-closed auth: the GET handler accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET or ?token= (INGEST), returning 401 ({ error: "unauthorized" })
// otherwise before snapshotting portfolios. Token is read at REQUEST time; the
// snapshot_all_user_portfolios RPC + log run into after() (stubbed no-op), so the
// 202 accept is observable without DB I/O. We pin the guard, then drive the 202.

const cap = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { cap.fn = fn } }
})
const dst = vi.hoisted(() => ({
  snapshot: { data: { snapshots_written: 7 } as any, error: null as any },
  snapshotThrows: false,
  logThrows: false,
  runs: [] as any[],
}))
const sb = vi.hoisted(() => ({
  rpc: async (name: string, args: any) => {
    const s = (globalThis as any).__dst
    if (name === "log_pipeline_run") {
      if (s.logThrows) throw new Error("log down")
      s.runs.push(args)
      return { data: null, error: null }
    }
    if (s.snapshotThrows) throw new Error("snapshot exploded")
    return s.snapshot
  },
}) as any)
;(globalThis as any).__dst = dst
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST } from "@/app/api/cron/daily-portfolio-snapshot/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/daily-portfolio-snapshot"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET
const url = "https://t/api/cron/daily-portfolio-snapshot"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("GET /api/cron/daily-portfolio-snapshot — auth guards", () => {
  it("401s with no authorization header", async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/daily-portfolio-snapshot — success path (202 accept, work deferred)", () => {
  it("202s and reports the pipeline accepted with the INGEST bearer token", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("daily-portfolio-snapshot")
  })

  it("also accepts the CRON_SECRET bearer token", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await GET(makeReq({ url, method: "GET", token: "test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("daily-portfolio-snapshot")
  })

  it("POST alias reaches the same 202 accept when authed", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})

// --- the after() body: the silent-run legs the 202 hides ---

describe("GET /api/cron/daily-portfolio-snapshot — deferred snapshot body", () => {
  async function accept() {
    dst.runs = []
    cap.fn = null
    await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(cap.fn).toBeTypeOf("function")
    await cap.fn!()
    return dst.runs[0]
  }

  beforeEach(() => {
    dst.snapshot = { data: { snapshots_written: 7 }, error: null }
    dst.snapshotThrows = false
    dst.logThrows = false
  })

  it("logs an ok run carrying the RPC's snapshots_written", async () => {
    const run = await accept()
    expect(run.p_pipeline).toBe("daily-portfolio-snapshot")
    expect(run.p_ok).toBe(true)
    expect(run.p_rows_written).toBe(7)
    expect(run.p_error).toBeNull()
    expect(run.p_extra.result).toEqual({ snapshots_written: 7 })
  })

  it("falls back to rows_written when the RPC uses that key instead", async () => {
    dst.snapshot = { data: { rows_written: 3 }, error: null }
    expect((await accept()).p_rows_written).toBe(3)
  })

  it("coerces a non-numeric/absent count to 0 rather than NaN", async () => {
    dst.snapshot = { data: { snapshots_written: "not-a-number" }, error: null }
    expect((await accept()).p_rows_written).toBe(0)
  })

  it("logs ok:false with the message when the snapshot RPC errors", async () => {
    dst.snapshot = { data: null, error: { message: "snapshot rpc failed" } }
    const run = await accept()
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toBe("snapshot rpc failed")
    expect(run.p_rows_written).toBe(0)
  })

  it("logs ok:false when the snapshot RPC throws outright", async () => {
    dst.snapshotThrows = true
    const run = await accept()
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toBe("snapshot exploded")
  })

  it("swallows a log_pipeline_run failure without throwing out of after()", async () => {
    dst.logThrows = true
    cap.fn = null
    await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })
})
