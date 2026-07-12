import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/panini-circulation-refresh.
// Fail-closed auth: authed() accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET
// only (read at REQUEST time), 401ing otherwise before any circulation refresh.
//
// Two authed 2xx accepts, both status 202:
//   • feed INERT (default, no PANINI_FEED_MODE) → immediate logged no-op
//     `{ accepted:false, skipped:"feed_inert", collection:"panini_blockchain" }`.
//   • feed ENABLED → circulation refresh is deferred into after() (stubbed no-op)
//     and the route acks `{ accepted:true, collection:"panini_blockchain",
//     started_at }`.
// The feed module is mocked with a hoisted `enabled` flag so both branches are
// reachable; the Supabase seam (log_pipeline_run) is a chainable inert stub.

const h = vi.hoisted(() => ({ enabled: false }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/chains/panini/feed", () => ({
  paniniFeedEnabled: () => h.enabled,
  paniniFeedMode: () => (h.enabled ? "cryptoslam" : ""),
  fetchPaniniEditions: async () =>
    h.enabled
      ? [{ id: "e1", player: "Player One", set: "Base", parallel: "Silver", mintCap: 100, circulation: 5 }]
      : [],
}))
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
    nextUrl: new URL("https://t/api/cron/panini-circulation-refresh"),
  }) as any

import { POST } from "@/app/api/cron/panini-circulation-refresh/route"

const url = "https://t/api/cron/panini-circulation-refresh"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  h.enabled = false
})

afterEach(() => {
  h.enabled = false
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/cron/panini-circulation-refresh — auth guards", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/panini-circulation-refresh — success path", () => {
  it("202s with skipped:'feed_inert' when the feed is unconfigured (default)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("feed_inert")
    expect(body.collection).toBe("panini_blockchain")
  })

  it("202s with accepted:true when the feed is enabled (refresh deferred to after())", async () => {
    h.enabled = true
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("panini_blockchain")
    expect(typeof body.started_at).toBe("string")
  })
})
