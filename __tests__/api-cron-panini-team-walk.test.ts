// __tests__/api-cron-panini-team-walk.test.ts
//
// POST /api/cron/panini-team-walk — the receiver for scripts/panini-team-walk.mjs.
// What must hold:
//   - no bearer, no write (401);
//   - a malformed body is a 400 that names the problem, before any DB call;
//   - an ingest reports what the RPC WROTE, and a failed or count-less write is a
//     non-2xx — the walker reads that as a failed flush and withholds `complete`,
//     which is what stops a partial walk from retiring live listings.

import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
const rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
const heartbeat = { landed: true, opts: null as unknown }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: rpcResult.data, error: rpcResult.error }
    },
  },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({
  writeInvocationHeartbeat: async (opts: unknown) => {
    heartbeat.opts = opts
    return heartbeat.landed
  },
}))

import { POST } from "@/app/api/cron/panini-team-walk/route"
import { parseTeamWalkBody } from "@/lib/chains/panini/team-walk"

const TOKEN = "t0ken"
const base = { sport: "Basketball", team: "Portland Trail Blazers", walk_started_at: "2026-09-24T14:32:27.599Z" }
const req = (body: unknown, auth = `Bearer ${TOKEN}`) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    json: async () => {
      if (body === "BAD") throw new Error("bad json")
      return body
    },
  }) as never

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  calls.length = 0
  rpcResult.data = null
  rpcResult.error = null
  heartbeat.landed = true
  heartbeat.opts = null
})

describe("auth + validation", () => {
  it("401s without the bearer and never touches the DB", async () => {
    expect((await POST(req({ op: "heartbeat", ...base }, ""))).status).toBe(401)
    expect((await POST(req({ op: "heartbeat", ...base }, "Bearer nope"))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })
  it("400s a non-JSON body and a bad op, before any DB call", async () => {
    expect((await POST(req("BAD"))).status).toBe(400)
    const r = await POST(req({ op: "delete", ...base }))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/op must be/)
    expect(calls).toHaveLength(0)
  })
  it("parseTeamWalkBody names each rejection", () => {
    expect(parseTeamWalkBody(null)).toMatchObject({ ok: false })
    expect(parseTeamWalkBody({ ...base, op: "heartbeat", sport: "Soccer" })).toMatchObject({ ok: false, reason: /sport/ })
    expect(parseTeamWalkBody({ ...base, op: "heartbeat", team: "  " })).toMatchObject({ ok: false, reason: /team/ })
    expect(parseTeamWalkBody({ ...base, op: "heartbeat", walk_started_at: "yesterday" })).toMatchObject({ ok: false, reason: /walk_started_at/ })
    expect(parseTeamWalkBody({ ...base, op: "ingest", rows: {}, complete: false })).toMatchObject({ ok: false, reason: /rows/ })
    expect(parseTeamWalkBody({ ...base, op: "ingest", rows: new Array(1001).fill({}), complete: false })).toMatchObject({ ok: false, reason: /at most/ })
    expect(parseTeamWalkBody({ ...base, op: "ingest", rows: [], complete: "yes" })).toMatchObject({ ok: false, reason: /complete/ })
    expect(parseTeamWalkBody({ ...base, op: "finish", pages: -1, listings_seen: 0, written: 0, ok: true })).toMatchObject({ ok: false, reason: /non-negative/ })
    expect(parseTeamWalkBody({ ...base, op: "finish", pages: 1, listings_seen: 0, written: 0, ok: "true" })).toMatchObject({ ok: false, reason: /ok must/ })
  })
})

describe("heartbeat", () => {
  it("writes the panini-team-walk marker at the walk's start", async () => {
    const r = await POST(req({ op: "heartbeat", ...base }))
    expect(r.status).toBe(200)
    expect(heartbeat.opts).toMatchObject({ pipeline: "panini-team-walk", startedAtMs: Date.parse(base.walk_started_at) })
  })
  it("a heartbeat that did not land is a 503, not a 200", async () => {
    heartbeat.landed = false
    expect((await POST(req({ op: "heartbeat", ...base }))).status).toBe(503)
  })
})

describe("ingest", () => {
  it("passes the flush through and reports what the RPC WROTE", async () => {
    rpcResult.data = { written: 2, mapped: 2, unmapped: 0, retired: 0 }
    const r = await POST(req({ op: "ingest", ...base, rows: [{ sku: "a", psku: "p" }], complete: false }))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ written: 2, mapped: 2, unmapped: 0, retired: 0 })
    expect(calls[0]).toEqual({
      fn: "panini_team_listings_ingest",
      args: { p_sport: "Basketball", p_team_raw: "Portland Trail Blazers", p_walk_started_at: base.walk_started_at, p_rows: [{ sku: "a", psku: "p" }], p_complete: false },
    })
  })
  it("an RPC error is a non-2xx and publishes no driver message", async () => {
    rpcResult.error = { message: 'relation "panini_team_listings" does not exist', code: "42P01" }
    const r = await POST(req({ op: "ingest", ...base, rows: [], complete: true }))
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await r.json())).not.toMatch(/panini_team_listings/)
  })
  it("an answer with no write count is a 502, never a success", async () => {
    rpcResult.data = {}
    expect((await POST(req({ op: "ingest", ...base, rows: [], complete: false }))).status).toBe(502)
  })
})

describe("finish", () => {
  it("logs the run with the walker's own ok and counts", async () => {
    const r = await POST(
      req({ op: "finish", ...base, pages: 12, listings_seen: 340, written: 340, ok: false, error: "page 13: no readable products response", extra: { complete: false } }),
    )
    expect(r.status).toBe(200)
    expect(calls[0].fn).toBe("log_pipeline_run")
    expect(calls[0].args).toMatchObject({
      p_pipeline: "panini-team-walk",
      p_rows_found: 340,
      p_rows_written: 340,
      p_ok: false,
      p_error: "page 13: no readable products response",
      p_extra: { complete: false, target: "Basketball:Portland Trail Blazers", pages: 12 },
    })
  })
  it("a failed run-log write is a non-2xx", async () => {
    rpcResult.error = { message: "boom" }
    expect((await POST(req({ op: "finish", ...base, pages: 0, listings_seen: 0, written: 0, ok: true }))).status).toBeGreaterThanOrEqual(400)
  })
})
