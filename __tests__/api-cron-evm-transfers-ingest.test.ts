import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/evm-transfers-ingest (+ GET alias).
// Two-stage fail-closed guard (read at REQUEST time): 500 if INGEST_SECRET_TOKEN
// is unset (server misconfigured), else 401 on a missing/wrong Bearer or ?token=
// before any ingest. The heavy EVM block-scan runs inside after() (stubbed
// no-op) — the evm-rpc log walk is deferred — so the "ingest queued" ack is
// observable without any getLogs/DB I/O. We pin both guards, then drive the 200.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "insert", "update", "upsert", "maybeSingle"]) s[m] = () => s
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/evm-rpc", () => ({
  getLogs: async () => [],
  getBlockByNumber: async () => null,
}))

import { POST, GET } from "@/app/api/cron/evm-transfers-ingest/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/evm-transfers-ingest"),
  }) as any

const savedIngest = process.env.INGEST_SECRET_TOKEN
const url = "https://t/api/cron/evm-transfers-ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("evm-transfers-ingest — Vercel cron authorisation", () => {
  // ⚠ Regression pin for a LIVE 401. The first scheduled tick after this route
  // was added to vercel.json returned 401 at 2026-09-02 22:44:26Z, because
  // Vercel cron sends `Bearer $CRON_SECRET` and the route accepted only
  // INGEST_SECRET_TOKEN. A 401 returns before any `pipeline_runs` row is
  // written, so the pipeline read as dormant rather than broken — which is why
  // this is pinned as a test and not just fixed.
  const saved = { cron: process.env.CRON_SECRET, ingest: process.env.INGEST_SECRET_TOKEN }
  afterEach(() => {
    if (saved.cron === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved.cron
    if (saved.ingest === undefined) delete process.env.INGEST_SECRET_TOKEN
    else process.env.INGEST_SECRET_TOKEN = saved.ingest
  })

  it("accepts Bearer CRON_SECRET, the header Vercel actually sends", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-tok"
    process.env.CRON_SECRET = "cron-tok"
    const { GET } = await import("@/app/api/cron/evm-transfers-ingest/route")
    const res = await GET(makeReq({ auth: "Bearer cron-tok" }))
    expect(res.status).toBe(200)
  })

  it("still accepts Bearer INGEST_SECRET_TOKEN for manual runs", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest-tok"
    process.env.CRON_SECRET = "cron-tok"
    const { GET } = await import("@/app/api/cron/evm-transfers-ingest/route")
    const res = await GET(makeReq({ auth: "Bearer ingest-tok" }))
    expect(res.status).toBe(200)
  })

  it("an UNSET CRON_SECRET must not let a bare `Bearer ` through", async () => {
    // The fail-soft class: an empty expected value turns the literal "Bearer "
    // into a valid credential for every caller.
    process.env.INGEST_SECRET_TOKEN = "ingest-tok"
    delete process.env.CRON_SECRET
    const { GET } = await import("@/app/api/cron/evm-transfers-ingest/route")
    expect((await GET(makeReq({ auth: "Bearer " }))).status).toBe(401)
    expect((await GET(makeReq({ auth: "Bearer wrong" }))).status).toBe(401)
  })
})

describe("POST /api/cron/evm-transfers-ingest — auth guards", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req("Bearer whatever"))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})

describe("POST /api/cron/evm-transfers-ingest — success path (immediate ack, scan deferred)", () => {
  it("200s and reports 'ingest queued' with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("ingest queued")
    expect(typeof body.started_at).toBe("string")
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("ingest queued")
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
