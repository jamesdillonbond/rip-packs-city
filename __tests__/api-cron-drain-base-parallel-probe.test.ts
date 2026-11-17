import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/drain-base-parallel-probe (+ GET alias).
// Fail-closed auth: authed() accepts verifyAdminRequest (RPC_ADMIN_TOKEN) or a
// Bearer/`?token=` matching CRON_SECRET / INGEST_SECRET_TOKEN / RPC_ADMIN_TOKEN;
// otherwise adminUnauthorizedResponse() → 401, before any edge-fn trigger. Tokens
// are read at REQUEST time. The success path only fires the edge fn via one raw
// fetch, so we stub global fetch to a 202 and assert the accept body (ok / edge_fn
// / trigger). We pin the guard, then drive the 200 accept.

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/drain-base-parallel-probe"),
  }) as any

import { POST, GET } from "@/app/api/cron/drain-base-parallel-probe/route"

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET
const savedAdmin = process.env.RPC_ADMIN_TOKEN
const savedSbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const url = "https://t/api/cron/drain-base-parallel-probe"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  process.env.RPC_ADMIN_TOKEN = "test-admin-secret"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test"
  // Edge-fn trigger returns 202 → route reports ok:true.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => "" }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
  if (savedAdmin === undefined) delete process.env.RPC_ADMIN_TOKEN
  else process.env.RPC_ADMIN_TOKEN = savedAdmin
  if (savedSbUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = savedSbUrl
})

describe("POST /api/cron/drain-base-parallel-probe — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/drain-base-parallel-probe — success path (edge-fn fired)", () => {
  it("200s and reports the edge fn fired (trigger 202) with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.edge_fn).toBe("backfill-topshot-base-parallel-probe")
    expect(body.trigger).toBe("202")
  })

  it("also accepts the RPC_ADMIN_TOKEN via ?token=", async () => {
    const res = await POST(makeReq({ url, token: "test-admin-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("GET alias reaches the same accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).edge_fn).toBe("backfill-topshot-base-parallel-probe")
  })
})
