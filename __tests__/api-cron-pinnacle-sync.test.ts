import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/pinnacle-sync.
// Fail-closed auth (read at REQUEST time): the GET handler requires Bearer
// INGEST_SECRET_TOKEN exactly and 401s otherwise before rebuilding the per-render
// Pinnacle FMV home. The data seam is `createClient` from @supabase/supabase-js
// (called at module top), stubbed so `pinnacle_fmv_recalc_render_all` returns a
// fixture — the route then logs and returns 200 {status:"ok",fmv_recalc_render}.
// Token is request-time, so the top-level import + env-in-beforeEach regime works.

const { sb, afterCbs } = vi.hoisted(() => {
  const afterCbs: Array<() => unknown> = []
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async (fn: string) => {
    if (fn === "pinnacle_fmv_recalc_render_all") return { data: { renders_priced: 42 }, error: null }
    return { data: null, error: null }
  }
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb, afterCbs }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
// The 2026-07-18 CRON-30S conversion moved the recalc into next/server `after()`,
// which throws "called outside a request scope" under vitest. Capture the callback
// and run it explicitly so the route body stays covered.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void afterCbs.push(cb) }
})

import { GET } from "@/app/api/cron/pinnacle-sync/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-sync"),
  }) as any

const url = "https://t/api/cron/pinnacle-sync"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  afterCbs.length = 0
})

// Drain any work the route deferred to after(), as the real request scope would.
async function drainAfter() {
  const cbs = [...afterCbs]
  afterCbs.length = 0
  for (const cb of cbs) await cb()
}

describe("GET /api/cron/pinnacle-sync", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/pinnacle-sync — success path (render-FMV refresh)", () => {
  // 2026-07-18 converted this route to the CRON-30S pattern: it returns 202
  // {status:"accepted"} immediately and does the render-FMV recalc inside after(),
  // so cron-job.org stops timing out at 30s. The old contract asserted here was a
  // synchronous 200 {status:"ok", fmv_recalc_render, errors} — that payload is no
  // longer returned to the caller, so we assert the accept envelope and then drain
  // after() to keep the recalc body itself covered.
  it("202s {status:'accepted'} and defers the recalc to after()", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: "accepted" })
    expect(afterCbs).toHaveLength(1)
  })

  it("runs the render-FMV recalc when the deferred work drains", async () => {
    const rpcCalls: string[] = []
    const origRpc = sb.rpc
    sb.rpc = async (fn: string, args?: unknown) => {
      rpcCalls.push(fn)
      return origRpc(fn, args)
    }
    try {
      await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
      await drainAfter()
    } finally {
      sb.rpc = origRpc
    }
    expect(rpcCalls).toContain("pinnacle_fmv_recalc_render_all")
    expect(afterCbs).toHaveLength(0)
  })
})

// PIN-SYNC-INVOKED regression guard (2026-08-03 shipped the fix; these tests pin it).
//
// This route's observability has broken TWICE. It originally logged nothing at all
// (the PIN-FMV2 2.4-day freeze 2026-06-04..06 was invisible), and after PIN-SYNC-OBS
// added logging the CRON-30S conversion moved every logRun INSIDE after() — so when
// Vercel drops the deferred work the run leaves no row while the recalc still
// completes. That produced a false stall on 2026-08-02: the DB fn self-logged
// ok=true with 2,160 renders priced while `pinnacle-sync` logged nothing, and
// detect_stalled_pipelines paged Telegram for a pipeline that was never down.
//
// The fix ships a synchronous phase:"invoked" marker before after() is scheduled.
// Nothing pinned it, so a future refactor could quietly move logging back inside
// after() and restore the exact defect twice already fixed. These do.
function captureLogRuns() {
  const calls: Array<{ fn: string; args: any }> = []
  const origRpc = sb.rpc
  sb.rpc = async (fn: string, args?: any) => {
    calls.push({ fn, args })
    return origRpc(fn, args)
  }
  return {
    calls,
    logs: () => calls.filter((c) => c.fn === "log_pipeline_run"),
    restore: () => {
      sb.rpc = origRpc
    },
  }
}

describe("GET /api/cron/pinnacle-sync — invoked-marker observability", () => {
  it("writes the phase:'invoked' marker SYNCHRONOUSLY, before after() runs", async () => {
    const cap = captureLogRuns()
    try {
      await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    } finally {
      cap.restore()
    }
    // The marker must exist the moment the 202 is returned — that is the whole
    // point. If logging moves back inside after(), this is empty.
    const logs = cap.logs()
    expect(logs).toHaveLength(1)
    expect(logs[0].args.p_pipeline).toBe("pinnacle-sync")
    expect(logs[0].args.p_extra.phase).toBe("invoked")
    // ok:true with zero rows so a heartbeat cannot inflate v_pipeline_failure_rates.
    expect(logs[0].args.p_ok).toBe(true)
    expect(logs[0].args.p_rows_written).toBe(0)
    // ...and the actual work must still be deferred, not pulled inline.
    expect(cap.calls.some((c) => c.fn === "pinnacle_fmv_recalc_render_all")).toBe(false)
    expect(afterCbs).toHaveLength(1)
  })

  it("marker and completion share one started_at, so they correlate as ONE run", async () => {
    const cap = captureLogRuns()
    try {
      await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
      await drainAfter()
    } finally {
      cap.restore()
    }
    const logs = cap.logs()
    expect(logs).toHaveLength(2)
    expect(logs[0].args.p_extra.phase).toBe("invoked")
    expect(logs[1].args.p_extra.phase).toBe("complete")
    // log_pipeline_run is a plain INSERT, so these are two rows. Threading the GET's
    // startedAtIso into runPinnacleSync is what lets a reader pair them into a single
    // run instead of seeing an orphan heartbeat plus an unrelated result.
    expect(logs[1].args.p_started_at).toBe(logs[0].args.p_started_at)
    expect(logs[1].args.p_rows_written).toBe(42)
    expect(logs[1].args.p_ok).toBe(true)
    expect(logs[1].args.p_extra.fmv_recalc_render).toEqual({ renders_priced: 42 })
  })

  it("a failing recalc still lands a phase:'complete' row with ok:false", async () => {
    const cap = captureLogRuns()
    const origRpc = sb.rpc
    // Layer the failure on top of the capture so the call is still recorded.
    sb.rpc = async (fn: string, args?: any) => {
      const res = await origRpc(fn, args)
      if (fn === "pinnacle_fmv_recalc_render_all") {
        return { data: null, error: { message: "statement timeout" } }
      }
      return res
    }
    try {
      await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
      await drainAfter()
    } finally {
      cap.restore()
    }
    const logs = cap.logs()
    expect(logs).toHaveLength(2)
    // A failed run must be visibly failed, not merely absent — "no row" is the
    // ambiguous state this whole fix exists to eliminate.
    expect(logs[1].args.p_ok).toBe(false)
    expect(logs[1].args.p_extra.phase).toBe("complete")
    expect(logs[1].args.p_error).toContain("statement timeout")
    expect(logs[1].args.p_rows_written).toBe(0)
  })

  it("logRun never lets an observability failure break the run (best-effort)", async () => {
    // logRun swallows its own errors by design: a broken pipeline_runs write must
    // not fail the FMV recalc it is only describing.
    const origRpc = sb.rpc
    sb.rpc = async (fn: string, args?: any) => {
      if (fn === "log_pipeline_run") throw new Error("pipeline_runs unavailable")
      return origRpc(fn, args)
    }
    try {
      const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
      expect(res.status).toBe(202)
      await expect(drainAfter()).resolves.toBeUndefined()
    } finally {
      sb.rpc = origRpc
    }
  })
})
