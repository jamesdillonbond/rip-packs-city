import { describe, it, expect, beforeEach, vi } from "vitest"

// 2026-09-29 — "I don't see a clean way to look for Blazers moments in Sniper."
// The Top Shot pool was the newest 200 of ~27k open ts_listings rows, rows that
// carry no team, so every pool deal had teamName "" and the Team filter (client
// side, and never sent to the route) searched only what was already loaded.
// Live: 915 open Blazers listings, none reachable by picking the team.
//
// Pinned here:
//   * `?team=` reads THAT team's listings (editions.team_name -> play ids ->
//     ts_listings), not the newest-200 slice;
//   * default-board pool rows carry their edition's team, so the dropdown lists them;
//   * the response carries the league's teams, so a team absent from the board is pickable;
//   * a failed team read is a DEGRADED board, never an honest "no Blazers deals".

type Op = [string, unknown[]]
type Call = { table: string; ops: Op[] }

const fx = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
  resolve: (() => ({ data: [], error: null })) as (table: string, ops: Array<[string, unknown[]]>) => { data: unknown; error: unknown },
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
}))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => factory(),
  deleteCache: () => {},
}))
vi.mock("@/lib/supabase", () => {
  const builder = (table: string) => {
    const call = { table, ops: [] as Array<[string, unknown[]]> }
    fx.calls.push(call)
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "gte", "lte", "gt", "lt", "order", "limit", "range", "ilike", "filter", "match"]) {
      b[m] = (...args: unknown[]) => { call.ops.push([m, args]); return b }
    }
    const run = () => Promise.resolve(fx.resolve(table, call.ops))
    b.then = (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => run().then(f, r)
    b.catch = (r?: (e: unknown) => unknown) => run().catch(r)
    b.single = run
    b.maybeSingle = run
    return b
  }
  return {
    supabaseAdmin: {
      from: (t: string) => builder(t),
      rpc: async (name: string) => fx.rpc[name] ?? { data: [], error: null },
    },
  }
})
vi.mock("@/lib/fmv-display-guard", () => ({
  loadTopshotFmvGuard: async () => new Map(),
  guardTopshotFmv: (_m: unknown, _id: string, fmv: number) => ({ effectiveFmv: fmv, lowConfidenceFmv: false }),
}))

const { GET } = await import("@/app/api/sniper-feed/route")
const get = (qs = "") => new Request(`https://t/api/sniper-feed${qs}`)

const BLAZERS = "Portland Trail Blazers"

function listing(i: number, setId: number, playId: number) {
  return {
    listing_id: `L${setId}-${playId}-${i}`, flow_id: `F${setId}-${playId}-${i}`,
    set_id: setId, play_id: playId, parallel_id: 0,
    serial_number: i + 10, circulation_count: 1000, price_usd: 10 + i,
    player_name: "Damian Lillard", set_name: "Base Set", moment_tier: "COMMON", series_number: 4,
    is_locked: false, listed_at: "2026-09-29T00:00:00Z", ingested_at: `2026-09-29T00:${String(i % 60).padStart(2, "0")}:00Z`,
  }
}

// Pricing + team rows for every edition the tests touch.
const EDITIONS = [
  { id: "uuid-1-2", external_id: "1:2", set_id_onchain: 1, play_id_onchain: 2, team_name: BLAZERS, thumbnail_url: null },
  { id: "uuid-5-7", external_id: "5:7", set_id_onchain: 5, play_id_onchain: 7, team_name: "Boston Celtics", thumbnail_url: null },
]

const opArgs = (ops: Op[], name: string) => ops.filter(([m]) => m === name).map(([, a]) => a)
const tsCalls = () => (fx.calls as Call[]).filter((c) => c.table === "ts_listings")

function defaultResolve(poolRows: unknown[]) {
  return (table: string, ops: Op[]) => {
    if (table === "editions") {
      const team = opArgs(ops, "eq").find((a) => a[0] === "team_name")?.[1]
      return { data: team ? EDITIONS.filter((e) => e.team_name === team) : EDITIONS, error: null }
    }
    if (table === "ts_listings") {
      const inPlay = opArgs(ops, "in").find((a) => a[0] === "play_id")?.[1] as number[] | undefined
      const rows = inPlay ? (poolRows as Array<{ play_id: number }>).filter((r) => inPlay.includes(r.play_id)) : poolRows
      return { data: rows, error: null }
    }
    return { data: [], error: null }
  }
}

beforeEach(() => {
  fx.calls = []
  fx.rpc = {
    get_editions_latest_fmv_wide: {
      data: EDITIONS.map((e) => ({
        edition_id: e.id, fmv_usd: 100, wap_usd: 95, floor_price_usd: 80, confidence: "HIGH",
        days_since_sale: 2, sales_count_30d: 14, computed_at: "2026-09-28T00:00:00Z",
      })),
      error: null,
    },
    get_teams_for_league: { data: [{ team_name: BLAZERS, has_moments: true }, { team_name: "Boston Celtics", has_moments: true }], error: null },
  }
})

describe("sniper-feed ?team= reads the team's listings from the whole pool", () => {
  // Blazers rows (1:2), a same-PLAY row in a set the team has no edition in
  // (9:2 — must not ride in on the play id), and 30 Celtics rows (5:7).
  const pool = [
    ...Array.from({ length: 26 }, (_, i) => listing(i, 1, 2)),
    listing(99, 9, 2),
    ...Array.from({ length: 30 }, (_, i) => listing(i, 5, 7)),
  ]

  it("queries ts_listings by the team's play ids and returns only that team's listings", async () => {
    fx.resolve = defaultResolve(pool)
    const res = await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent(BLAZERS)}`))
    const body = await res.json()

    const teamEd = (fx.calls as Call[]).find((c) => c.table === "editions" && opArgs(c.ops, "eq").some((a) => a[0] === "team_name"))
    expect(teamEd, "the team's editions were never looked up").toBeTruthy()
    expect(opArgs(teamEd!.ops, "eq")).toContainEqual(["team_name", BLAZERS])

    // Every ts_listings read on a team pick is scoped by play id — none is the
    // unscoped newest-200 slice that made the team unreachable.
    expect(tsCalls().length).toBeGreaterThan(0)
    for (const c of tsCalls()) expect(opArgs(c.ops, "in")).toContainEqual(["play_id", [2]])

    expect(body.degraded).toBe(false)
    expect(body.deals.length).toBeGreaterThan(0)
    for (const d of body.deals) {
      expect(d.teamName).toBe(BLAZERS)
      expect(d.editionKey).toBe("1:2")
    }
    expect(body.deals.some((d: { flowId: string }) => d.flowId.startsWith("F9-2-"))).toBe(false)
  })

  it("a failed team-editions read degrades the board rather than concluding there are no deals", async () => {
    const base = defaultResolve(pool)
    fx.resolve = (table, ops) =>
      table === "editions" && opArgs(ops, "eq").some((a) => a[0] === "team_name")
        ? { data: null, error: { message: "boom" } }
        : base(table, ops)
    const body = await (await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent(BLAZERS)}`))).json()
    expect(body.sourcesFailed).toContain("ts_listings")
    expect(body.degraded).toBe(true)
  })
})

describe("sniper-feed default board carries team names and the league's teams", () => {
  it("pool deals take their edition's team, and teamOptions lists teams not on the board", async () => {
    fx.resolve = defaultResolve(Array.from({ length: 26 }, (_, i) => listing(i, 5, 7)))
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.length).toBeGreaterThan(0)
    for (const d of body.deals) expect(d.teamName).toBe("Boston Celtics")
    // Blazers have no listing on this board and are still offered.
    expect(body.teamOptions).toContain(BLAZERS)
    // The default board stays the unscoped newest slice.
    expect(tsCalls().some((c) => opArgs(c.ops, "in").length === 0)).toBe(true)
  })
})
