import { describe, it, expect, beforeEach, vi } from "vitest"

// CRON-30S ack mode for GET /api/cron/stale-fmv-monitor?ack=1 (2026-09-19).
//
// WHY THIS EXISTS. The route gained a cron-job.org caller (`RPC Stale FMV
// Monitor`, job 8474274) because GitHub delivers ops-monitor.yml's schedule at
// ~6/day (register #124). cron-job.org aborts at 30 s, marks the run FAILED and
// auto-disables the entry after enough of those; this route ran >28 s on 8 of
// 24 ticks in the 2026-09-19 IO spell. So the console caller passes ?ack=1 and
// gets 202 while the check runs inside after() on the same invocation — the
// sentinel's pattern, and these tests pin the same three properties its tests
// pin:
//   1. the 202 carries NO VERDICT (no status / staleness / integrity fields) —
//      a dispatch receipt rendered as "fresh" would be a failed-read-as-answer;
//   2. the route writes its OWN heartbeat tagged `cron-ack` (never `schedule`),
//      because a fire-and-forget caller has no runner to write one;
//   3. a throwing heartbeat never blocks the 202 or the deferred run.
// And the negative: without ?ack=1 the synchronous report is unchanged, so the
// GHA lane that greps `status` keeps working.

const { afterCalls, heartbeats, hb } = vi.hoisted(() => ({
  afterCalls: [] as Array<(...a: any[]) => any>,
  heartbeats: [] as Array<Record<string, any>>,
  hb: { throws: false },
}))

vi.mock("@/lib/pipeline/heartbeat", () => ({
  writeInvocationHeartbeat: async (opts: Record<string, any>) => {
    heartbeats.push(opts)
    if (hb.throws) throw new Error("db down")
    return true
  },
}))

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>()
  return {
    ...mod,
    after: (fn: any) => {
      afterCalls.push(fn)
    },
  }
})

// Minimal supabase chain: every read resolves fresh + clean so the synchronous
// path returns status:'ok' and the deferred path completes without alerting.
const { sbChain, rpcCalls } = vi.hoisted(() => {
  const RECENT_ISO = new Date(Date.now() - 5 * 60_000).toISOString()
  const rpcCalls: Array<{ fn: string; args: any }> = []
  const sbChain: any = {
    from: () => sbChain,
    select: () => sbChain,
    order: () => sbChain,
    limit: () => sbChain,
    is: () => sbChain,
    gte: () => sbChain,
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      return { data: null, error: null }
    },
    then: (resolve: any) =>
      resolve({ data: [{ computed_at: RECENT_ISO, sold_at: RECENT_ISO }], count: 0, error: null }),
  }
  return { sbChain, rpcCalls }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sbChain }))
vi.mock("@/lib/ops-alert", () => ({ sendOpsAlert: vi.fn(async () => {}) }))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/cron/stale-fmv-monitor/route"

const TOKEN = "test-ingest-token"

function get(url: string, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(url, { method: "GET", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  delete process.env.CRON_SECRET
  afterCalls.length = 0
  heartbeats.length = 0
  rpcCalls.length = 0
  hb.throws = false
})

describe("GET /api/cron/stale-fmv-monitor?ack=1 — dispatch receipt, not a verdict", () => {
  it("returns 202 immediately and defers the check to after()", async () => {
    const res = await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1", `Bearer ${TOKEN}`))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toEqual({ accepted: true, mode: "ack" })
    // The check has NOT run yet — nothing was logged to pipeline_runs synchronously.
    expect(rpcCalls.filter((c) => c.fn === "log_pipeline_run")).toHaveLength(0)
    expect(afterCalls).toHaveLength(1)
  })

  it("the ack body carries none of the report fields", async () => {
    const res = await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1", `Bearer ${TOKEN}`))
    const body = await res.json()
    for (const k of [
      "status",
      "fmv_staleness_minutes",
      "fmv_threshold_minutes",
      "data_integrity_ok",
      "data_integrity_checked",
      "total_editions",
      "checked_at",
    ]) {
      expect(body, `ack body must not carry '${k}'`).not.toHaveProperty(k)
    }
  })

  it("the deferred run completes the real check and writes its terminal pipeline_runs row", async () => {
    await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1", `Bearer ${TOKEN}`))
    await afterCalls[0]()
    const logs = rpcCalls.filter((c) => c.fn === "log_pipeline_run")
    expect(logs).toHaveLength(1)
    expect(logs[0].args.p_pipeline).toBe("stale-fmv-monitor")
    expect(logs[0].args.p_ok).toBe(true)
    expect(logs[0].args.p_extra.stale).toBe(false)
  })

  it("writes its own invocation heartbeat tagged cron-ack, never schedule", async () => {
    await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1", `Bearer ${TOKEN}`))
    expect(heartbeats).toHaveLength(1)
    expect(heartbeats[0].pipeline).toBe("stale-fmv-monitor")
    expect(heartbeats[0].extra.event).toBe("cron-ack")
    expect(heartbeats[0].extra.event).not.toBe("schedule")
  })

  it("a throwing heartbeat blocks neither the 202 nor the deferred run", async () => {
    hb.throws = true
    const res = await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1", `Bearer ${TOKEN}`))
    expect(res.status).toBe(202)
    expect(afterCalls).toHaveLength(1)
  })

  it("still 401s in ack mode without the bearer — ack is not an auth bypass", async () => {
    const res = await GET(get("https://t/api/cron/stale-fmv-monitor?ack=1"))
    expect(res.status).toBe(401)
    expect(afterCalls).toHaveLength(0)
    expect(heartbeats).toHaveLength(0)
  })
})

describe("GET /api/cron/stale-fmv-monitor without ack — the GHA lane's synchronous report is unchanged", () => {
  it("returns the full report with status and writes no cron-ack heartbeat", async () => {
    const res = await GET(get("https://t/api/cron/stale-fmv-monitor", `Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body).toHaveProperty("fmv_staleness_minutes")
    expect(afterCalls).toHaveLength(0)
    expect(heartbeats).toHaveLength(0)
    expect(rpcCalls.filter((c) => c.fn === "log_pipeline_run")).toHaveLength(1)
  })
})
