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
//   * a failed team read is a DEGRADED board, never an honest "no Blazers deals";
//   * a pick covers its whole FRANCHISE (a team label is not a franchise): "LA
//     Clippers" also finds "Los Angeles Clippers" editions, and says so via
//     `teamApplied` so the client does not re-filter them away on the exact label.

type Op = [string, unknown[]]
type Call = { table: string; ops: Op[] }

const fx = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
  resolve: (() => ({ data: [], error: null })) as (table: string, ops: Array<[string, unknown[]]>) => { data: unknown; error: unknown },
  rpc: {} as Record<string, { data: unknown; error: unknown } | ((args: any) => { data: unknown; error: unknown })>,
  rpcCalls: [] as Array<{ name: string; args: any }>,
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
      rpc: async (name: string, args?: any) => {
        fx.rpcCalls.push({ name, args })
        const v = fx.rpc[name]
        return typeof v === "function" ? v(args) : v ?? { data: [], error: null }
      },
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
  { id: "uuid-3-4", external_id: "3:4", set_id_onchain: 3, play_id_onchain: 4, team_name: "LA Clippers", thumbnail_url: null },
  { id: "uuid-6-8", external_id: "6:8", set_id_onchain: 6, play_id_onchain: 8, team_name: "Los Angeles Clippers", thumbnail_url: null },
]

const opArgs = (ops: Op[], name: string) => ops.filter(([m]) => m === name).map(([, a]) => a)
const tsCalls = () => (fx.calls as Call[]).filter((c) => c.table === "ts_listings")

function defaultResolve(poolRows: unknown[]) {
  return (table: string, ops: Op[]) => {
    if (table === "editions") {
      const teams = opArgs(ops, "in").find((a) => a[0] === "team_name")?.[1] as string[] | undefined
      return { data: teams ? EDITIONS.filter((e) => teams.includes(e.team_name)) : EDITIONS, error: null }
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
  fx.rpcCalls = []
  fx.rpc = {
    get_editions_latest_fmv_wide: {
      data: EDITIONS.map((e) => ({
        edition_id: e.id, fmv_usd: 100, wap_usd: 95, floor_price_usd: 80, confidence: "HIGH",
        days_since_sale: 2, sales_count_30d: 14, computed_at: "2026-09-28T00:00:00Z",
      })),
      error: null,
    },
    get_teams_for_league: {
      data: [BLAZERS, "Boston Celtics", "LA Clippers"].map((team_name) => ({ team_name, has_moments: true })),
      error: null,
    },
    // Registry names incl. the historic label; the slugs say which belong together.
    league_team_abbr: { data: [{ team_name: "Los Angeles Clippers", abbr: "LAC" }, { team_name: BLAZERS, abbr: "POR" }], error: null },
    team_franchise_slugs: { data: ["portland-trail-blazers"], error: null },
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

    const teamEd = (fx.calls as Call[]).find((c) => c.table === "editions" && opArgs(c.ops, "in").some((a) => a[0] === "team_name"))
    expect(teamEd, "the team's editions were never looked up").toBeTruthy()
    expect(opArgs(teamEd!.ops, "in")).toContainEqual(["team_name", [BLAZERS]])

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
    expect(body.teamApplied).toBe(BLAZERS)
  })

  it("a failed team-editions read degrades the board rather than concluding there are no deals", async () => {
    const base = defaultResolve(pool)
    fx.resolve = (table, ops) =>
      table === "editions" && opArgs(ops, "in").some((a) => a[0] === "team_name")
        ? { data: null, error: { message: "boom" } }
        : base(table, ops)
    const body = await (await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent(BLAZERS)}`))).json()
    expect(body.sourcesFailed).toContain("ts_listings")
    expect(body.degraded).toBe(true)
  })
})

describe("sniper-feed ?team= covers every label of the franchise", () => {
  const pool = [
    ...Array.from({ length: 13 }, (_, i) => listing(i, 3, 4)),
    ...Array.from({ length: 13 }, (_, i) => listing(i + 20, 6, 8)),
    ...Array.from({ length: 10 }, (_, i) => listing(i, 5, 7)),
  ]

  it("'LA Clippers' also returns the 'Los Angeles Clippers' editions, each keeping its own label", async () => {
    fx.rpc.team_franchise_slugs = { data: ["la-clippers", "los-angeles-clippers", "san-diego-clippers"], error: null }
    fx.resolve = defaultResolve(pool)
    const body = await (await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent("LA Clippers")}`))).json()
    expect(body.degraded).toBe(false)
    const teams = new Set(body.deals.map((d: { teamName: string }) => d.teamName))
    expect(teams).toEqual(new Set(["LA Clippers", "Los Angeles Clippers"]))
    expect(body.teamApplied).toBe("LA Clippers")
  })

  it("the sparse-board edition fallback is asked once per franchise label and merges them", async () => {
    fx.rpc.team_franchise_slugs = { data: ["la-clippers", "los-angeles-clippers"], error: null }
    const edRow = (moment_id: string, team_name: string) => ({
      moment_id, player_name: "Clipper", team_name, set_name: "Base Set", series_name: "4", tier: "COMMON",
      circulation_count: 1000, ask_price: 50, fmv_usd: 100, confidence: "HIGH", listed_at: "2026-09-29T00:00:00Z",
    })
    fx.rpc.get_topshot_sniper_deals = (args: { p_team: string }) => ({
      data: args.p_team === "LA Clippers" ? [edRow("11:12", "LA Clippers")]
        : args.p_team === "Los Angeles Clippers" ? [edRow("13:14", "Los Angeles Clippers"), edRow("11:12", "LA Clippers")]
        : [],
      error: null,
    })
    fx.resolve = defaultResolve(pool) // 2 editions: sparse, so the fallback runs
    const body = await (await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent("LA Clippers")}`))).json()
    const asked = fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals").map((c) => c.args.p_team).sort()
    expect(asked).toEqual(["LA Clippers", "Los Angeles Clippers"])
    const edIds = body.deals.filter((d: { flowId: string }) => !d.flowId).map((d: { momentId: string }) => d.momentId).sort()
    expect(edIds).toEqual(["11:12", "13:14"]) // merged, and 11:12 once
    expect(body.degraded).toBe(false)
  })

  it("a failed franchise lookup falls back to the exact label AND reports the board as narrowed", async () => {
    fx.rpc.team_franchise_slugs = { data: null, error: { message: "boom" } }
    fx.resolve = defaultResolve(pool)
    const body = await (await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent("LA Clippers")}`))).json()
    expect(body.deals.length).toBeGreaterThan(0)
    for (const d of body.deals) expect(d.teamName).toBe("LA Clippers")
    expect(body.sourcesFailed).toContain("team-franchise")
    expect(body.degraded).toBe(true)
  })
})

describe("sniper-feed a team pick always gets every edition's floor", () => {
  // 30 Blazers editions in the newest listings: NOT sparse (>= 25), which used
  // to skip the edition-level read and leave a newest-200 slice as the board.
  const eds = Array.from({ length: 30 }, (_, i) => ({
    id: `uuid-b${i}`, external_id: `${100 + i}:${200 + i}`, set_id_onchain: 100 + i, play_id_onchain: 200 + i, team_name: BLAZERS, thumbnail_url: null,
  }))
  const pool = eds.map((e, i) => listing(i, e.set_id_onchain, e.play_id_onchain))

  it("calls the edition-level read on a team pick even when the pool is not sparse", async () => {
    fx.resolve = (table) => {
      if (table === "editions") return { data: eds, error: null }
      if (table === "ts_listings") return { data: pool, error: null }
      return { data: [], error: null }
    }
    await GET(get(`?collection=nba-top-shot&team=${encodeURIComponent(BLAZERS)}`))
    const calls = fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals")
    expect(calls.map((c) => c.args.p_team)).toEqual([BLAZERS])
    // Every priced edition of the team (<= 504), not the top 200 by discount.
    expect(calls[0].args.p_limit).toBe(1000)
  })

  it("the default board still skips it when the pool is not sparse (control)", async () => {
    fx.resolve = (table) => {
      if (table === "editions") return { data: eds, error: null }
      if (table === "ts_listings") return { data: pool, error: null }
      return { data: [], error: null }
    }
    await GET(get("?collection=nba-top-shot"))
    expect(fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals")).toHaveLength(0)
  })
})

describe("sniper-feed ?player= reads the player's listings from the whole pool (2026-09-29)", () => {
  // "Lillard" answered 0 deals live while 54 Lillard listings were open: the
  // player filter ran over the finished newest-200 board, and the edition-floor
  // read was never told the player.
  const tatum = (i: number) => ({ ...listing(i, 5, 7), player_name: "Jayson Tatum" })
  const pool = [...Array.from({ length: 40 }, (_, i) => tatum(i)), ...Array.from({ length: 3 }, (_, i) => listing(i + 50, 1, 2))]
  const resolve = (table: string, ops: Op[]) => {
    if (table === "editions") return { data: EDITIONS, error: null }
    if (table === "ts_listings") {
      const like = opArgs(ops, "ilike").find((a) => a[0] === "player_name")?.[1] as string | undefined
      const needle = like ? like.replace(/^%|%$/g, "").toLowerCase() : null
      return { data: needle ? pool.filter((r) => r.player_name.toLowerCase().includes(needle)) : pool.slice(0, 40), error: null }
    }
    return { data: [], error: null }
  }

  it("asks ts_listings for the player, tells the floor read the player, and returns only that player", async () => {
    fx.resolve = resolve
    const body = await (await GET(get("?collection=nba-top-shot&player=Lillard"))).json()
    const ts = tsCalls()
    expect(ts.length).toBeGreaterThan(0)
    for (const c of ts) expect(opArgs(c.ops, "ilike")).toContainEqual(["player_name", "%Lillard%"])
    const floor = fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals")
    expect(floor.map((c) => c.args.p_player)).toEqual(["Lillard"])
    expect(body.deals.length).toBeGreaterThan(0)
    for (const d of body.deals) expect(d.playerName).toBe("Damian Lillard")
  })

  it("escapes LIKE wildcards in what was typed", async () => {
    fx.resolve = resolve
    await GET(get(`?collection=nba-top-shot&player=${encodeURIComponent("50%_off")}`))
    const like = opArgs(tsCalls()[0].ops, "ilike")[0]?.[1]
    expect(like).toBe("%50\\%\\_off%")
  })

  it("the default board still reads the unscoped newest slice (control)", async () => {
    fx.resolve = resolve
    await GET(get("?collection=nba-top-shot"))
    expect(tsCalls().some((c) => opArgs(c.ops, "ilike").length === 0)).toBe(true)
    // (this pool is one edition, so the sparse fallback may run — never scoped to a player)
    for (const c of fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals")) expect(c.args.p_player).toBeUndefined()
  })
})

describe("sniper-feed narrowing filters reach the whole pool (2026-09-29)", () => {
  // The Legendary tab answered 0 deals live while 699 Legendary listings were
  // open and ≥1,000 Legendary editions had a priced floor: the tier filtered
  // the newest-200 pool, and a non-sparse pool skipped the edition-floor read.
  const eds30 = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, external_id: `${300 + i}:${400 + i}`, set_id_onchain: 300 + i, play_id_onchain: 400 + i, team_name: BLAZERS, thumbnail_url: null }))
  const pool = eds30.map((e, i) => listing(i, e.set_id_onchain, e.play_id_onchain)) // 30 editions: not sparse
  const resolve = (table: string) =>
    table === "editions" ? { data: eds30, error: null } : table === "ts_listings" ? { data: pool, error: null } : { data: [], error: null }
  const floorCalls = () => fx.rpcCalls.filter((c) => c.name === "get_topshot_sniper_deals")

  it("a tier tab scopes the pool to that tier and always reads every edition floor of it", async () => {
    fx.resolve = resolve
    await GET(get("?collection=nba-top-shot&tier=legendary"))
    for (const c of tsCalls()) expect(opArgs(c.ops, "eq")).toContainEqual(["moment_tier", "LEGENDARY"])
    expect(floorCalls().map((c) => [c.args.p_rarity, c.args.p_limit])).toEqual([["legendary", 1000]])
  })

  it("a minimum discount always reads the edition floors (the pool cannot be filtered by discount)", async () => {
    fx.resolve = resolve
    await GET(get("?collection=nba-top-shot&minDiscount=30"))
    expect(floorCalls().map((c) => c.args.p_min_discount)).toEqual([30])
  })

  it("a market-wide sort (best discount, cheapest, highest FMV) reads the floors; 'Recently listed' does not", async () => {
    for (const sort of ["discount", "price_asc", "fmv_desc"]) {
      fx.rpcCalls = []
      fx.resolve = resolve
      await GET(get(`?collection=nba-top-shot&sortBy=${sort}`))
      expect(floorCalls().map((c) => [c.args.p_sort_by, c.args.p_limit])).toEqual([[sort, 1000]])
    }
    fx.rpcCalls = []
    fx.resolve = resolve
    await GET(get("?collection=nba-top-shot&sortBy=listed_desc"))
    expect(floorCalls()).toHaveLength(0)
  })

  it("a max price is pushed into the pool read, and on its own does not force the floor read", async () => {
    fx.resolve = resolve
    await GET(get("?collection=nba-top-shot&maxPrice=5&sortBy=listed_desc"))
    for (const c of tsCalls()) expect(opArgs(c.ops, "lte")).toContainEqual(["price_usd", 5])
    expect(floorCalls()).toHaveLength(0)
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
    expect(body.teamApplied).toBeNull()
  })
})
