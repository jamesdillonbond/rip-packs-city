import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route-integration test for /api/cron/snapshot-institutional-wallets.
// Auth: Bearer INGEST_SECRET_TOKEN / CRON_SECRET or ?token= (INGEST captured at
// import as a module const). The success path is SYNCHRONOUS: a cron_heartbeat
// upsert, then invokeEdgeWithRetry (3 attempts with 1500ms×2^n backoff) against
// the edge fn. Legs pinned beyond the guards: every auth arm, the heartbeat's
// error + throw branches (both non-fatal), the retry loop recovering on attempt
// 2, exhausting all 3 to a 502, the thrown-fetch arm, and the non-JSON edge body
// falling back to a truncated string. Backoff runs under fake timers.

const st = {
  heartbeat: { error: null as any },
  heartbeatThrows: false,
  edge: [] as Array<{ ok: boolean; status: number; text: string } | "throw">,
  fetchCalls: 0,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({}),
    rpc: async () => {
      if (st.heartbeatThrows) throw new Error("heartbeat exploded")
      return { data: null, error: st.heartbeat.error }
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co"

vi.stubGlobal("fetch", vi.fn(async () => {
  st.fetchCalls++
  const next = st.edge.shift() ?? { ok: true, status: 202, text: JSON.stringify({ queued: true }) }
  if (next === "throw") throw new Error("socket hang up")
  return { ok: next.ok, status: next.status, text: async () => next.text }
}))

import { makeReq } from "./cron-req-helper"

const mod = await import("@/app/api/cron/snapshot-institutional-wallets/route")

// invokeEdgeWithRetry sleeps between attempts; drive those timers virtually.
async function withTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const p = run()
    await vi.advanceTimersByTimeAsync(60_000)
    return await p
  } finally {
    vi.useRealTimers()
  }
}

beforeEach(() => {
  st.heartbeat = { error: null }
  st.heartbeatThrows = false
  st.edge = []
  st.fetchCalls = 0
})
afterEach(() => vi.useRealTimers())

describe("GET /api/cron/snapshot-institutional-wallets — auth", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    expect((await mod.GET(makeReq({ method: "GET" }))).status).toBe(401)
  })
  it("401s with a wrong bearer token", async () => {
    expect((await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))).status).toBe(401)
  })
  it("accepts the CRON_SECRET bearer", async () => {
    expect((await mod.GET(makeReq({ method: "GET", auth: "Bearer test-cron-secret" }))).status).toBe(202)
  })
  it("accepts the ?token= query param", async () => {
    expect((await mod.GET(makeReq({ method: "GET", token: "test-ingest-token" }))).status).toBe(202)
  })
})

describe("GET /api/cron/snapshot-institutional-wallets — heartbeat", () => {
  const authed = () => makeReq({ method: "GET", auth: "Bearer test-ingest-token" })

  it("202s and surfaces the edge status/body on a clean run", async () => {
    const body = await (await mod.GET(authed())).json()
    expect(body.accepted).toBe(true)
    expect(body.edge_status).toBe(202)
    expect(body.edge_body).toEqual({ queued: true })
    expect(body.attempts).toBe(1)
  })

  it("continues when the heartbeat RPC returns an error (non-fatal)", async () => {
    st.heartbeat = { error: { message: "heartbeat down" } }
    expect((await mod.GET(authed())).status).toBe(202)
  })

  it("continues when the heartbeat RPC throws (non-fatal)", async () => {
    st.heartbeatThrows = true
    expect((await mod.GET(authed())).status).toBe(202)
  })

  it("POST alias reaches the same accept", async () => {
    expect((await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))).status).toBe(202)
  })
})

describe("GET /api/cron/snapshot-institutional-wallets — edge retry loop", () => {
  const authed = () => makeReq({ method: "GET", auth: "Bearer test-ingest-token" })

  it("retries a non-ok edge response and reports the attempt it recovered on", async () => {
    st.edge = [
      { ok: false, status: 503, text: JSON.stringify({ error: "cold" }) },
      { ok: true, status: 202, text: JSON.stringify({ queued: true }) },
    ]
    const res = await withTimers(() => mod.GET(authed()))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.attempts).toBe(2)
  })

  it("retries a thrown fetch the same way", async () => {
    st.edge = ["throw", { ok: true, status: 202, text: JSON.stringify({ queued: true }) }]
    const res = await withTimers(() => mod.GET(authed()))
    expect(res.status).toBe(202)
    expect((await res.json()).attempts).toBe(2)
  })

  it("502s after exhausting all three attempts, carrying the last error", async () => {
    st.edge = [
      { ok: false, status: 500, text: JSON.stringify({ error: "boom" }) },
      { ok: false, status: 500, text: JSON.stringify({ error: "boom" }) },
      { ok: false, status: 500, text: JSON.stringify({ error: "boom" }) },
    ]
    const res = await withTimers(() => mod.GET(authed()))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.attempts).toBe(3)
    expect(body.error).toContain("edge 500")
    expect(st.fetchCalls).toBe(3)
  })

  it("502s when every attempt throws", async () => {
    st.edge = ["throw", "throw", "throw"]
    const res = await withTimers(() => mod.GET(authed()))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("socket hang up")
  })

  it("falls back to a truncated string when the edge body is not JSON", async () => {
    st.edge = [{ ok: true, status: 200, text: "plain text not json" }]
    const body = await (await mod.GET(authed())).json()
    expect(body.edge_body).toBe("plain text not json")
  })
})
