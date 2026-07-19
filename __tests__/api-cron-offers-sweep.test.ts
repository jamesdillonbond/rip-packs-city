import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/offers-sweep.
// Fail-closed auth: the POST handler (the sweep runner) requires Bearer /
// `?token=` == INGEST_SECRET_TOKEN and 401s otherwise before walking the Top
// Shot marketplace. Token is read at REQUEST time, so a top-level import + env
// in beforeEach reaches the success path. (GET is a deliberately public status
// endpoint — not tested here.)
//
// Success path (immediate 202 ack): the up-to-40-page GQL sweep + upsert +
// log_pipeline_run all run inside after() — stubbed to a no-op — so the route
// returns `{ ok:true, accepted:true, pipeline:"offers-sweep" }` (202) without any
// GQL/DB I/O. topshotGraphql and the Supabase seam are mocked inert regardless.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))
const sb = vi.hoisted(() => {
  const s: any = {}
  for (const m of [
    "from", "select", "eq", "neq", "in", "order", "limit", "gte", "lte", "lt",
    "gt", "is", "not", "or", "range", "match", "insert", "update", "upsert",
    "delete", "returns", "like",
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
    nextUrl: new URL("https://t/api/cron/offers-sweep"),
  }) as any

import { POST } from "@/app/api/cron/offers-sweep/route"

const url = "https://t/api/cron/offers-sweep"
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

describe("POST /api/cron/offers-sweep — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/offers-sweep — success path (immediate 202 ack)", () => {
  it("202s and reports ok/accepted/pipeline with the INGEST bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("offers-sweep")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })
})
