import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/candy/collections-census.ts — the rotating census of the non-registry Candy
// collections. The properties that matter: the page cursor advances ONLY after a page's
// writes land; a failed page fails the run and is re-read next time; holdings are written
// insert-only; a completed walk resets the cursor and stamps last_census_at.
// 2026-11-09: paging is by DAS CURSOR (keyset), never `page=` (an offset that timed out at
// page 228 on four runs). The mock cursor is "<addr>#<next page index>".

const state: {
  queue: any[]
  pages: Record<string, any[][]>
  dasThrows: Set<string>
  dasNoCursor: boolean
  dasCalls: Array<string | null>
  wmcError: any
  existingWmc: any[]
  existingEds: any[]
  readError: any
  hydrate: { hydrated: any[]; failed: any[] } | ((assets: any[]) => { hydrated: any[]; failed: any[] }) | null
  hydrateCalls: any[][]
  updates: Array<{ address: string; patch: any }>
  wmcUpserts: Array<{ rows: any[]; opts: any }>
  edUpserts: Array<{ rows: any[]; opts: any }>
  rpcs: string[]
  rpcArgs: any[]
} = { queue: [], pages: {}, dasThrows: new Set(), dasNoCursor: false, dasCalls: [], wmcError: null, existingWmc: [], existingEds: [], readError: null, hydrate: null, hydrateCalls: [], updates: [], wmcUpserts: [], edUpserts: [], rpcs: [], rpcArgs: [] }

vi.mock("@/lib/chains/solana/das", () => ({
  getAssetsByGroupCursor: async (addr: string, cursor: string | null) => {
    state.dasCalls.push(cursor)
    const idx = cursor ? Number(cursor.split("#")[1]) : 0
    if (state.dasThrows.has(`${addr}:${idx + 1}`)) throw new Error("DAS getAssetsByGroup HTTP 502")
    return { items: state.pages[addr]?.[idx] ?? [], total: 0, limit: 1000, page: 0, cursor: state.dasNoCursor ? undefined : `${addr}#${idx + 1}` }
  },
}))
vi.mock("@/lib/chains/solana/hydrate", () => ({
  isUnhydrated: (a: any) => a.bare === true,
  failureClass: (r: string) => r,
  hydrateFromJsonUri: async (assets: any[]) => {
    state.hydrateCalls.push(assets)
    if (typeof state.hydrate === "function") return state.hydrate(assets)
    return state.hydrate ?? { hydrated: assets.map((a) => ({ ...a, bare: false, ed: a.realEd ?? a.ed })), failed: [] }
  },
}))
vi.mock("@/lib/chains/solana/escrow", () => ({
  attributeEscrowHeldToSellers: async (_db: any, rows: any[]) => ({ rows, remapped: 0, unmatched: 0, error: null }),
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
  CANDY_MLB_UUID: "c1",
  normalizeEdition: (a: any) => ({ external_id: "ed-" + a.ed, collection_id: "c1", player_name: "Seth Brown", team_name: "Athletics", set_name: "2022 Leadoff ICONs", tier: "COMMON", circulation_count: 850 }),
  normalizeSerial: (a: any) => ({ moment_id: a.id, wallet_address: a.owner, collection_id: "c1", edition_key: "ed-" + a.ed, serial_number: 1, image_url: null }),
}))
vi.mock("@/lib/chains/solana/candy-sets", () => ({ candySetForAsset: () => ({ key: "c:x" }) }))
vi.mock("@/lib/candy/collections", () => ({ loadCandyCollections: async () => ({ sets: [], error: null }) }))

import { runCollectionsCensus } from "@/lib/candy/collections-census"

const full = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, owner: "W", ed: "a" }))

function db() {
  return {
    rpc: async (name: string, args: any) => { state.rpcs.push(name); state.rpcArgs.push(args); return { data: 4, error: null } },
    from: (table: string) => {
      if (table === "candy_collections") {
        const b: any = {
          _patch: null,
          select: () => b, neq: () => b, eq: (_c: string, v: string) => {
            if (b._patch) { state.updates.push({ address: v, patch: b._patch }); return Promise.resolve({ error: null }) }
            return b
          },
          not: () => b, order: () => b,
          limit: async () => ({ data: state.queue, error: null }),
          update: (patch: any) => { b._patch = patch; return b },
        }
        return b
      }
      const t = table
      return {
        // existing-row reads (REUSE / REPOINT)
        select: () => {
          const q: any = { eq: () => q, in: async (_c: string, vals: string[]) => {
            if (state.readError) return { data: null, error: state.readError }
            if (t === "wallet_moments_cache") return { data: state.existingWmc.filter((r) => vals.includes(r.moment_id)), error: null }
            return { data: state.existingEds.filter((e) => vals.includes(e.external_id)), error: null }
          } }
          return q
        },
        upsert: (rows: any[], opts: any) => {
          if (t === "wallet_moments_cache") state.wmcUpserts.push({ rows, opts })
          else state.edUpserts.push({ rows, opts })
          return { select: async () => (t === "wallet_moments_cache" && state.wmcError ? { data: null, error: state.wmcError } : { data: rows.map((r) => ({ moment_id: r.moment_id, external_id: r.external_id })), error: null }) }
        },
      }
    },
  }
}

beforeEach(() => {
  state.queue = []; state.pages = {}; state.dasThrows = new Set(); state.dasNoCursor = false; state.dasCalls = []; state.wmcError = null
  state.existingWmc = []; state.existingEds = []; state.readError = null; state.hydrate = null; state.hydrateCalls = []
  state.updates = []; state.wmcUpserts = []; state.edUpserts = []; state.rpcs = []; state.rpcArgs = []
})

describe("runCollectionsCensus", () => {
  it("walks a collection to its short page, insert-only, then resets the cursor and stamps the walk", async () => {
    state.queue = [{ address: "A", name: "2022 Leadoff ICONs", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(1000, "p1-"), [...full(3, "p2-"), { id: "pk", owner: "W", ed: "a", kind: "pack" }, { id: "bt", owner: "W", ed: "a", kind: "burnt" }]]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.cards).toBe(1003)
    expect(r.completed).toBe(1)
    expect(state.wmcUpserts.every((u) => u.opts.ignoreDuplicates === true)).toBe(true)
    expect(state.edUpserts.every((u) => u.opts.ignoreDuplicates === true)).toBe(true)
    const last = state.updates.filter((u) => u.address === "A").at(-1)!.patch
    expect(last).toMatchObject({ census_page: 1, census_cursor: null, census_walk_started_at: null, last_census_items: 1003, last_census_error: null })
    // the second page was asked BY CURSOR, not by page number
    expect(state.dasCalls).toEqual([null, "A#1"])
    expect(typeof last.last_census_at).toBe("string")
    // The ghost purge is SCOPED to the moments this run inserted — never the unscoped
    // whole-collection rank that timed out at 120 s on 1.4M rows.
    expect(state.rpcs).toEqual(["purge_candy_wmc_ghost_rows_for"])
    expect(new Set(state.rpcArgs[0].p_moment_ids)).toEqual(new Set([...full(1000, "p1-"), ...full(3, "p2-")].map((x) => x.id)))
    // Holdings are born labelled — never left for a whole-collection denorm.
    expect(state.wmcUpserts[0].rows[0]).toMatchObject({ tier: "COMMON", player_name: "Seth Brown", set_name: "2022 Leadoff ICONs", mint_count: 850, team_name: "Athletics" })
  })

  it("a failed DAS page does not advance the cursor and fails the run", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 3, census_cursor: "A#2", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.dasThrows.add("A:3")
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/page 3: .*502/)
    expect(state.updates.some((u) => u.patch.census_page !== undefined)).toBe(false)
  })

  it("a rejected holdings write does not advance the cursor (the page is re-read next run)", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), full(1000, "y")]
    state.wmcError = { message: "deadlock detected" }
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(state.updates.some((u) => u.patch.census_page !== undefined)).toBe(false)
  })

  it("a resumed walk keeps going from its saved CURSOR and reports its item count as unknown", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), full(5, "y")]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.cards).toBe(5)
    expect(state.dasCalls).toEqual(["A#1"])
    const last = state.updates.at(-1)!.patch
    expect(last.census_page).toBe(1)
    expect(last.census_cursor).toBeNull()
    expect(last.last_census_items).toBeNull()
  })

  it("a walk the old PAGE-mode code left in flight (page > 1, no cursor) restarts from the top", async () => {
    // 2022 Leadoff ICONs sat at census_page 228 with no cursor on 2026-11-09
    state.queue = [{ address: "A", name: "2022 Leadoff ICONs", census_page: 228, census_cursor: null, census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), full(2, "y")]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(state.dasCalls).toEqual([null, "A#1"])
    expect(state.updates[0].patch).toMatchObject({ census_page: 1, census_cursor: null })
    // read whole in this run, so its count is known
    expect(state.updates.at(-1)!.patch).toMatchObject({ last_census_items: 1002, census_cursor: null })
  })

  it("a FULL page without a cursor is an error, never the end of the walk", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [full(1000, "x"), full(2, "y")]
    state.dasNoCursor = true
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.completed).toBe(0)
    expect(r.error).toMatch(/full page without a cursor/)
    // no completion stamp, no advanced position
    expect(state.updates.some((u) => u.patch.last_census_at !== undefined)).toBe(false)
    expect(state.updates.some((u) => typeof u.patch.census_cursor === "string")).toBe(false)
  })

  // ── unhydrated assets (2026-11-09: 4,844 fabricated editions, 328,317 cards) ──

  it("REUSE: an unhydrated card whose existing row names a COMPLETE edition takes it, with no fetch", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W2", ownership: { owner: "W2" }, ed: "ignored", bare: true }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W1", edition_key: "ed-good", serial_number: 7 }]
    state.existingEds = [{ external_id: "ed-good", tier: "RARE", player_name: "Josh VanMeter", team_name: "Pirates", set_name: "S", circulation_count: 50, thumbnail_url: "https://img" }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(state.hydrateCalls).toEqual([])
    expect(r.hydrated_reused).toBe(1)
    const row = state.wmcUpserts.flatMap((u) => u.rows).find((x) => x.moment_id === "m1")
    // new owner, the card's real edition and labels
    expect(row).toMatchObject({ wallet_address: "W2", edition_key: "ed-good", serial_number: 7, tier: "RARE", player_name: "Josh VanMeter", image_url: "https://img" })
    expect(r.cards).toBe(1)
  })

  it("FETCH + REPOINT: an unhydrated card on a FABRICATED edition is fetched and its row overwritten", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "name-only", realEd: "real", bare: true }]]
    // existing row points at the fabricated edition (no thumbnail -> not complete -> no reuse)
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-name-only", serial_number: null }]
    state.existingEds = [{ external_id: "ed-name-only", tier: null, player_name: null, team_name: null, set_name: null, circulation_count: null, thumbnail_url: null }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(state.hydrateCalls.flat().map((a) => a.id)).toEqual(["m1"])
    expect(r.hydrated_fetched).toBe(1)
    const overwrite = state.wmcUpserts.find((u) => u.opts.ignoreDuplicates === false)!
    expect(overwrite.rows).toHaveLength(1)
    expect(overwrite.rows[0]).toMatchObject({ moment_id: "m1", wallet_address: "W", edition_key: "ed-real" })
    expect(r.wmc_repointed).toBe(1)
    // the repointed row is NOT also offered insert-only
    expect(state.wmcUpserts.filter((u) => u.opts.ignoreDuplicates === true).flatMap((u) => u.rows).some((x) => x.moment_id === "m1")).toBe(false)
  })

  it("SKIP: a card whose metadata fetch fails is never written, is counted, and makes the walk count unknown", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "name-only", bare: true }, { id: "m2", owner: "W", ed: "a" }]]
    state.hydrate = { hydrated: [], failed: [{ id: "m1", reason: "HTTP 404" }] }
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.unhydrated_skipped).toBe(1)
    const written = state.wmcUpserts.flatMap((u) => u.rows).map((x) => x.moment_id)
    expect(written).toEqual(["m2"])
    // no edition was written under the name-only key
    expect(state.edUpserts.flatMap((u) => u.rows).map((e) => e.external_id)).not.toContain("ed-name-only")
    expect(state.updates.at(-1)!.patch).toMatchObject({ last_census_items: null })
    // WHY is reported, and 1 failed of 1 attempted (> 10 %) FAILS the run
    expect(r.hydrate_fail_reasons).toEqual({ "HTTP 404": 1 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/metadata fetch failed for 1 of 1 unhydrated cards \(HTTP 404 1\)/)
  })

  it("BREAKER: once >= 200 fetches ran and > 80 % failed, the rest of the run fetches nothing and keeps walking", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    const bare = (p: string) => Array.from({ length: 1000 }, (_, i) => ({ id: `${p}${i}`, owner: "W", ed: "n", bare: true }))
    state.pages.A = [bare("a"), bare("b"), full(3, "c")]
    // every fetch fails
    state.hydrate = (assets) => ({ hydrated: [], failed: assets.map((a) => ({ id: a.id, reason: "HTTP 403" })) })
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(state.hydrateCalls).toHaveLength(1) // page 2 was not fetched: breaker open
    expect(r.hydrate_fail_reasons).toEqual({ "HTTP 403": 1000, "breaker open": 1000 })
    expect(r.completed).toBe(1) // the walk still reached its end
    expect(r.ok).toBe(false)
  })

  it("a hydrated card already on the RIGHT edition is not rewritten", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "a" }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-a", serial_number: 1 }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.wmc_repointed).toBe(0)
    expect(state.wmcUpserts.every((u) => u.opts.ignoreDuplicates === true)).toBe(true)
  })

  it("a failed existing-row read fails the page and does not advance the cursor", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), full(5, "y")]
    state.readError = { message: "statement timeout" }
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/wmc read: statement timeout/)
    expect(state.updates.some((u) => u.patch.census_page !== undefined)).toBe(false)
    expect(state.wmcUpserts).toEqual([])
  })

  it("a spent budget walks nothing and claims nothing", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(5, "x")]
    let t = 0
    const r = await runCollectionsCensus(db(), { budgetMs: 10, now: () => (t += 100) })
    expect(r.cards).toBe(0)
    expect(r.completed).toBe(0)
  })
})
