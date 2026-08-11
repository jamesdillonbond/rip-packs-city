import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/allday-badge-ingest.
// Fail-closed auth: the POST handler accepts Bearer INGEST_SECRET_TOKEN or
// CRON_SECRET only, returning 401 otherwise before any badge ingest. We pin the
// guard AND drive the real 200: the token is read at REQUEST time, the DB seam is
// supabaseAdmin from @/lib/supabase (chainable stub — upsert/rpc return no error),
// and the handler is synchronous, so { ok, upserted, upsertErrors, jerseyUpdated }
// reflects the mocked upsert of the posted rows.

// Mutable config so error/telemetry branches are drivable, plus an rpc-call log
// so the final-POST log_pipeline_run row can be asserted on.
const sb: any = vi.hoisted(() => {
  const cfg: any = {
    upsertError: null as any,
    rpcData: 0 as any, // backfill_allday_edition_jersey return
    rpcError: null as any,
    logThrows: false,
    rpcCalls: [] as Array<{ name: string; args: any }>,
  }
  const s: any = { _cfg: cfg }
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "neq", "or", "range", "match", "insert", "update", "delete", "returns"]) s[m] = () => s
  s.single = async () => ({ data: {}, error: null })
  s.maybeSingle = async () => ({ data: null, error: null })
  s.rpc = async (name: string, args: any) => {
    cfg.rpcCalls.push({ name, args })
    if (name === "log_pipeline_run" && cfg.logThrows) throw new Error("log boom")
    return { data: cfg.rpcData, error: cfg.rpcError }
  }
  s.then = (resolve: any) => resolve({ data: [], error: null })
  // upsert() is awaited directly for its { error } — resolve to the configured outcome.
  s.upsert = () => ({ then: (resolve: any) => resolve({ error: cfg.upsertError }) })
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/allday-badge-ingest"),
  }) as any

import { POST } from "@/app/api/cron/allday-badge-ingest/route"

const url = "https://t/api/cron/allday-badge-ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  sb._cfg.upsertError = null
  sb._cfg.rpcData = 0
  sb._cfg.rpcError = null
  sb._cfg.logThrows = false
  sb._cfg.rpcCalls.length = 0
})

function logRow() {
  return sb._cfg.rpcCalls.find((c: any) => c.name === "log_pipeline_run")
}

describe("POST /api/cron/allday-badge-ingest", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/allday-badge-ingest — success path (synchronous upsert)", () => {
  it("200s with ok:true and upserted:0 for an empty rows payload", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: { rows: [] } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(0)
    expect(body.upsertErrors).toBe(0)
  })

  it("200s and reports upserted:1 for one valid badge row (mocked upsert, no error)", async () => {
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-cron-secret",
        body: {
          rows: [
            {
              external_id: 12345,
              player_name: "Test Player",
              set_name: "Test Set",
              tier: "COMMON",
              badges: [{ slug: "all-day-debut", title: "All Day Debut" }],
              circulation_count: 100,
            },
          ],
        },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(1)
    expect(body.upsertErrors).toBe(0)
  })

  it("400s on malformed JSON body (after auth passes)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad json")
  })
})

describe("POST /api/cron/allday-badge-ingest — row shaping + jersey + telemetry branches", () => {
  it("drops rows with no external_id (buildBadgeRow -> null) and reports upserted:0", async () => {
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: { rows: [{ player_name: "No Id" }, { external_id: "", set_name: "empty id" }] },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(0)
  })

  it("upserts across multiple chunks when rows exceed the chunk size (201 rows)", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({
      external_id: 1000 + i,
      set_name: "Big Set",
      circulation_count: 50,
    }))
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret", body: { rows } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.upserted).toBe(201) // two chunks (200 + 1), both no-error
    expect(body.upsertErrors).toBe(0)
  })

  it("reports ok:false and upsertErrors when the upsert returns an error", async () => {
    sb._cfg.upsertError = { message: "conflict" }
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: { rows: [{ external_id: 55, circulation_count: 10, burned: 2, owned: 8, locked: 4 }] },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.upserted).toBe(0)
    expect(body.upsertErrors).toBe(1)
  })

  it("fires the jersey backfill rpc and returns jerseyUpdated for valid jersey numbers", async () => {
    sb._cfg.rpcData = 3
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: {
          rows: [
            { external_id: 71, jersey_number: 23 },
            { external_id: 72, jersey_number: "00" }, // "00" -> 0, still a valid pair
          ],
        },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jerseyUpdated).toBe(3)
    const jerseyCall = sb._cfg.rpcCalls.find((c: any) => c.name === "backfill_allday_edition_jersey")
    expect(jerseyCall).toBeDefined()
    expect(jerseyCall.args.p_pairs.length).toBe(2)
  })

  it("skips the jersey rpc entirely when no jersey numbers are valid", async () => {
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: {
          rows: [
            { external_id: 81, jersey_number: 150 }, // out of 0..99 range -> null
            { external_id: 82, jersey_number: "N/A" }, // NaN -> null
          ],
        },
      })
    )
    const body = await res.json()
    expect(body.jerseyUpdated).toBe(0)
    expect(sb._cfg.rpcCalls.some((c: any) => c.name === "backfill_allday_edition_jersey")).toBe(false)
  })

  it("logs jerseyUpdated:0 (not the error) when the jersey rpc returns an error", async () => {
    sb._cfg.rpcError = { message: "rpc down" }
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: { rows: [{ external_id: 91, jersey_number: 12 }] },
      })
    )
    const body = await res.json()
    expect(body.jerseyUpdated).toBe(0)
  })

  it("logs a pipeline_run on the terminal (final:true) POST with the runner's stats", async () => {
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: {
          rows: [
            {
              external_id: 100,
              badges: [
                { slug: "rookie-mint", title: "Rookie Mint" },
                { slug: "", title: "dropped" }, // empty slug -> filtered out of set_play_tags
              ],
              circulation_count: 100,
            },
          ],
          final: true,
          ok: true,
          startedAt: "2026-08-10T00:00:00.000Z",
          stats: { editions_fetched: 10, rows_upserted: 1, editions_skipped: 2 },
        },
      })
    )
    expect(res.status).toBe(200)
    const row = logRow()
    expect(row).toBeDefined()
    expect(row.args.p_pipeline).toBe("allday-badge-ingest")
    expect(row.args.p_ok).toBe(true)
    expect(row.args.p_rows_found).toBe(10)
    expect(row.args.p_rows_written).toBe(1)
    expect(row.args.p_collection_slug).toBe("nfl_all_day")
  })

  it("logs p_ok:false / p_error:'upsert_errors' on the terminal POST when an upsert failed", async () => {
    sb._cfg.upsertError = { message: "conflict" }
    await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: {
          rows: [{ external_id: 110, circulation_count: 5 }],
          final: true,
          ok: true,
          stats: {},
        },
      })
    )
    const row = logRow()
    expect(row).toBeDefined()
    expect(row.args.p_ok).toBe(false)
    expect(row.args.p_error).toBe("upsert_errors")
  })

  it("survives a throwing log_pipeline_run on the terminal POST (still 200)", async () => {
    sb._cfg.logThrows = true
    const res = await POST(
      makeReq({
        url,
        auth: "Bearer test-ingest-secret",
        body: { rows: [{ external_id: 120, circulation_count: 5 }], final: true, ok: false },
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true) // upsert had no error
  })
})
