// __tests__/api-cron-panini-collector-walk.test.ts
//
// POST /api/cron/panini-collector-walk — the receiver for scripts/panini-collector-walk.mjs.
// What must hold:
//   - no bearer, no write (401); a malformed body is a 400 before any DB call;
//   - an ingest reports what the RPC WROTE and whether the DB judged the walk complete;
//     a failed or count-less write — including the run row — is a non-2xx;
//   - the run is ok only when the walker AND the DB say complete.

import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
const results: Record<string, { data: unknown; error: unknown }> = {}
const heartbeat = { landed: true, opts: null as unknown }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return results[fn] ?? { data: null, error: null }
    },
  },
}))
vi.mock("@/lib/pipeline/heartbeat", () => ({
  writeInvocationHeartbeat: async (opts: unknown) => {
    heartbeat.opts = opts
    return heartbeat.landed
  },
}))

import { POST } from "@/app/api/cron/panini-collector-walk/route"
import { MAX_HOLDINGS, parseCollectorWalkBody } from "@/lib/chains/panini/collector-walk"

const TOKEN = "t0ken"
const base = { username: "Jamesdillonbond", walk_started_at: "2026-09-27T20:00:00.000Z" }
const ingest = (over: Record<string, unknown> = {}) => ({
  op: "ingest",
  ...base,
  complete: true,
  profile_state: "public",
  reported_total: 2,
  unopened_packs: 12,
  error: null,
  holdings: [{ url_key: "p__1_10", psku: "p", serial_number: 1, mint_cap: 10 }, { url_key: "q__4_99" }],
  ...over,
})
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
  for (const k of Object.keys(results)) delete results[k]
  heartbeat.landed = true
  heartbeat.opts = null
})

describe("auth + validation", () => {
  it("401s without the bearer and never touches the DB", async () => {
    expect((await POST(req(ingest(), ""))).status).toBe(401)
    expect((await POST(req(ingest(), "Bearer nope"))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })
  it("400s a non-JSON body and a bad op, before any DB call", async () => {
    expect((await POST(req("BAD"))).status).toBe(400)
    expect((await POST(req({ op: "delete", ...base }))).status).toBe(400)
    expect(calls).toHaveLength(0)
  })
  it("parseCollectorWalkBody names each rejection", () => {
    expect(parseCollectorWalkBody({ ...ingest(), username: "0x1234567890abcdef1234" })).toMatchObject({ ok: false, reason: /username/ })
    expect(parseCollectorWalkBody({ ...ingest(), walk_started_at: "yesterday" })).toMatchObject({ ok: false, reason: /walk_started_at/ })
    expect(parseCollectorWalkBody({ ...ingest(), holdings: {} })).toMatchObject({ ok: false, reason: /holdings/ })
    expect(parseCollectorWalkBody({ ...ingest(), holdings: [{ athlete: "x" }] })).toMatchObject({ ok: false, reason: /url_key/ })
    expect(parseCollectorWalkBody({ ...ingest(), holdings: new Array(MAX_HOLDINGS + 1).fill({ url_key: "a" }) })).toMatchObject({ ok: false, reason: /at most/ })
    expect(parseCollectorWalkBody({ ...ingest(), complete: "yes" })).toMatchObject({ ok: false, reason: /complete/ })
    expect(parseCollectorWalkBody({ ...ingest(), profile_state: "open" })).toMatchObject({ ok: false, reason: /profile_state/ })
    expect(parseCollectorWalkBody({ ...ingest(), unopened_packs: -1 })).toMatchObject({ ok: false, reason: /unopened_packs/ })
    expect(parseCollectorWalkBody({ op: "plan", limit: 0 })).toMatchObject({ ok: false, reason: /limit/ })
  })
  it("an unread count stays null — never 0", () => {
    const r = parseCollectorWalkBody({ ...ingest(), unopened_packs: null, reported_total: undefined })
    expect(r).toMatchObject({ ok: true, value: { unopenedPacks: null, reportedTotal: null } })
  })
})

describe("plan", () => {
  it("returns linked usernames, capped at the limit", async () => {
    results.panini_collector_walk_targets = {
      data: [
        { username: "a", nickname: "A", last_complete_at: null },
        { username: "b", nickname: "B", last_complete_at: "2026-09-26T00:00:00Z" },
      ],
      error: null,
    }
    const r = await POST(req({ op: "plan", limit: 1 }))
    expect(await r.json()).toEqual({ targets: [{ username: "a", nickname: "A", last_complete_at: null }] })
  })
  it("a failed plan read is a non-2xx, not an empty plan", async () => {
    results.panini_collector_walk_targets = { data: null, error: { message: "boom" } }
    expect((await POST(req({ op: "plan", limit: 5 }))).status).toBeGreaterThanOrEqual(500)
  })
})

describe("heartbeat", () => {
  it("writes the marker at the walk's start; a miss is a 503", async () => {
    expect((await POST(req({ op: "heartbeat", ...base }))).status).toBe(200)
    expect(heartbeat.opts).toMatchObject({ pipeline: "panini-collector-walk", startedAtMs: Date.parse(base.walk_started_at), extra: { username: "jamesdillonbond" } })
    heartbeat.landed = false
    expect((await POST(req({ op: "heartbeat", ...base }))).status).toBe(503)
  })
})

describe("ingest", () => {
  it("sends the whole walk in one RPC call and logs an ok run when walker and DB agree", async () => {
    results.panini_collector_walk_ingest = { data: { written: 2, retired: 1, collected: 2, complete: true }, error: null }
    const r = await POST(req(ingest()))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ written: 2, retired: 1, collected: 2, complete: true, logged: true })
    expect(calls[0].fn).toBe("panini_collector_walk_ingest")
    expect(calls[0].args.p).toMatchObject({ username: "jamesdillonbond", complete: true, profile_state: "public", reported_total: 2, unopened_packs: 12 })
    expect((calls[0].args.p as { holdings: unknown[] }).holdings).toHaveLength(2)
    expect(calls[1]).toMatchObject({ fn: "log_pipeline_run", args: { p_pipeline: "panini-collector-walk", p_ok: true, p_error: null, p_rows_written: 2 } })
  })
  it("a walker 'complete' the DB rejects is logged NOT ok, with the reason", async () => {
    results.panini_collector_walk_ingest = { data: { written: 2, retired: 0, collected: 2, complete: false }, error: null }
    await POST(req(ingest()))
    expect(calls[1].args).toMatchObject({ p_ok: false, p_error: expect.stringMatching(/DB disagreed/) })
  })
  it("an incomplete walk is logged not ok", async () => {
    results.panini_collector_walk_ingest = { data: { written: 1, retired: 0, collected: 1, complete: false }, error: null }
    await POST(req(ingest({ complete: false, error: "stopped at 1/2 cards" })))
    expect(calls[1].args).toMatchObject({ p_ok: false, p_error: "stopped at 1/2 cards" })
  })
  it("an RPC error is a non-2xx and publishes no driver message", async () => {
    results.panini_collector_walk_ingest = { data: null, error: { message: 'relation "panini_user_holdings" does not exist', code: "42P01" } }
    const r = await POST(req(ingest()))
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await r.json())).not.toMatch(/panini_user_holdings/)
  })
  it("an answer with no write count is a 502, never a success", async () => {
    results.panini_collector_walk_ingest = { data: { retired: 0 }, error: null }
    expect((await POST(req(ingest()))).status).toBe(502)
  })
  it("a run row that did not land is a 503 that still says what was written", async () => {
    results.panini_collector_walk_ingest = { data: { written: 2, retired: 0, collected: 2, complete: true }, error: null }
    results.log_pipeline_run = { data: null, error: { message: "boom" } }
    const r = await POST(req(ingest()))
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ written: 2, logged: false })
  })
})
