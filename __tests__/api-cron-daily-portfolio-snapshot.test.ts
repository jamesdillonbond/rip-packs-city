import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/daily-portfolio-snapshot (+ POST alias).
// Fail-closed auth: the GET handler accepts Bearer INGEST_SECRET_TOKEN /
// CRON_SECRET or ?token= (INGEST), returning 401 ({ error: "unauthorized" })
// otherwise before snapshotting portfolios. Token is read at REQUEST time; the
// snapshot_all_user_portfolios RPC + log run into after() (stubbed no-op), so the
// 202 accept is observable without DB I/O. We pin the guard, then drive the 202.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const sb = vi.hoisted(() => ({ rpc: async () => ({ data: { snapshots_written: 0 }, error: null }) }) as any)
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
