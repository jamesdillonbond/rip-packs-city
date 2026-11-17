import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST/GET /api/cron/ownership-onchain-walk.
// Fail-closed auth: authed() checks a Bearer token (INGEST_SECRET_TOKEN /
// CRON_SECRET) at REQUEST time before any Flow REST walk and 401s on a
// missing/wrong credential.
//
// Success path (immediate 202 ack): the on-chain verification walk (Flow REST
// fan-out via fcl + topshot_ownership upsert + log_pipeline_run) is fire-and-
// forget inside after() — stubbed to a no-op — so the route returns
// `{ ok:true, accepted:true, pipeline:"ownership-onchain-walk" }` (202) with no
// live chain I/O. @/lib/flow and the Supabase seam are mocked inert regardless.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of [
    "from", "select", "eq", "neq", "in", "order", "limit", "gte", "lte", "lt",
    "gt", "is", "not", "or", "range", "match", "insert", "update", "upsert",
    "delete", "returns",
  ]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.then = (resolve: any) => resolve({ data: [], error: null })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/ownership-onchain-walk"),
  }) as any

import { POST, GET } from "@/app/api/cron/ownership-onchain-walk/route"

const url = "https://t/api/cron/ownership-onchain-walk"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

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

describe("POST /api/cron/ownership-onchain-walk — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/ownership-onchain-walk — success path (immediate 202 ack)", () => {
  it("202s and reports ok/accepted/pipeline with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("ownership-onchain-walk")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).pipeline).toBe("ownership-onchain-walk")
  })
})
