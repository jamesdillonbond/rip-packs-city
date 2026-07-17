import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of POST /api/backfill-edition-names — the TopShot on-chain metadata
// filler. The shallow suite stops at auth + the no-work 200. Here we drive the
// real Cadence-fan-out body via a mocked FCL client and assert:
//   - the WRITE contract: a stub int-pair edition is UPDATEd with name/tier/series
//     (only when null) plus the always-set play_category/play_type/game_date/
//     home_team/away_team/circulation_count columns, then `remaining` re-counted;
//   - an edition that yields no updatable metadata is counted failed (not written);
//   - a Cadence exception is caught per-edition -> failed++, sample_errors;
//   - the Step-1 query error -> honest 500.
// NOTE: the route memoizes set/circulation lookups in module-level Maps, so each
// test uses a DISTINCT setId:playId to avoid cross-test cache bleed.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  fcl: (_cadence: string) => undefined as unknown,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/flow", () => ({
  default: { query: async ({ cadence }: { cadence: string }) => state.fcl(cadence) },
}))

const { POST } = await import("@/app/api/backfill-edition-names/route")

const TOKEN = "ingest-secret"

function req(auth = "Bearer " + TOKEN): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/backfill-edition-names", { method: "POST", headers })
}

function fullMetaFcl(cadence: string): unknown {
  if (cadence.includes("getPlayMetaData"))
    return {
      FullName: "Damian Lillard",
      PlayCategory: "Dunk",
      PlayType: "Handles",
      DateOfMoment: "2026-01-15T00:00:00Z",
      TeamAtMoment: "Portland Trail Blazers",
      TeamAtMomentOpponent: "Los Angeles Lakers",
      Tier: "MOMENT_TIER_RARE",
    }
  if (cadence.includes("getNumMomentsInEdition")) return 15000
  if (cadence.includes("getSetSeries")) return 5
  if (cadence.includes("getSetName")) return "Base Set"
  return {}
}

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

let savedToken: string | undefined
beforeEach(() => {
  savedToken = process.env.INGEST_SECRET_TOKEN
  process.env.INGEST_SECRET_TOKEN = TOKEN
  state.fcl = fullMetaFcl
})
afterEach(() => {
  if (savedToken === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedToken
})

describe("backfill-edition-names — on-chain metadata fill", () => {
  it("UPDATEs a stub edition with the full metadata column contract and re-counts remaining", async () => {
    const spy = install({
      editions: [
        { data: [{ id: "e1", external_id: "3:45", name: null, tier: null, series: null }], error: null },
        { error: null }, // per-edition UPDATE ack
        { count: 7, error: null } as never, // Step-4 remaining count (cast: count-return)
      ],
      "rpc:execute_sql": { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      stubs_found: 1,
      updated: 1,
      failed: 0,
      tier_backfilled: 0,
      remaining: 7,
    })

    const upd = (spy.writes.editions ?? []).find((w) => w.method === "update")
    expect(upd?.rows[0]).toMatchObject({
      name: "Damian Lillard — Base Set",
      tier: "RARE",
      series: 5,
      play_category: "Dunk",
      play_type: "Handles",
      game_date: "2026-01-15",
      home_team: "Portland Trail Blazers",
      away_team: "Los Angeles Lakers",
      circulation_count: 15000,
    })
  })

  it("counts an edition with no updatable metadata as failed and never writes it", async () => {
    state.fcl = (cadence: string) => {
      if (cadence.includes("getNumMomentsInEdition")) return 0
      if (cadence.includes("getSetSeries")) return 0
      if (cadence.includes("getSetName")) return ""
      return {} // getPlayMetaData empty -> nothing to set
    }
    const spy = install({
      // name/tier/series ALREADY set -> no null fills; empty playMeta -> empty update
      editions: [
        { data: [{ id: "e2", external_id: "7:77", name: "Existing", tier: "RARE", series: 5 }], error: null },
        { count: 0, error: null } as never, // no UPDATE happens -> next editions await is the count
      ],
      "rpc:execute_sql": { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.updated).toBe(0)
    expect(body.failed).toBe(1)
    expect(String(body.sample_errors?.[0])).toContain("no metadata to update")
    expect(spy.writes.editions ?? []).toHaveLength(0)
  })

  it("catches a Cadence exception per-edition -> failed++ with a sample error", async () => {
    state.fcl = () => {
      throw new Error("flow node 503")
    }
    install({
      editions: [
        { data: [{ id: "e3", external_id: "8:88", name: null, tier: null, series: null }], error: null },
        { count: 3, error: null } as never,
      ],
      "rpc:execute_sql": { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.updated).toBe(0)
    expect(body.failed).toBe(1)
    expect(String(body.sample_errors?.[0])).toContain("flow node 503")
  })

  it("500s on the Step-1 editions query error", async () => {
    install({ editions: { data: null, error: { message: "select blew up" } } })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("select blew up")
  })

  it("short-circuits to a no-work 200 when there are no stub editions", async () => {
    install({ editions: { data: [], error: null } })
    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, updated: 0, failed: 0, remaining: 0 })
  })
})
