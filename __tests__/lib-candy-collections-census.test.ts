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
  updates: Array<{ address: string; patch: any }>
  wmcUpserts: Array<{ rows: any[]; opts: any }>
  edUpserts: Array<{ rows: any[]; opts: any }>
  rpcs: string[]
  rpcArgs: any[]
} = { queue: [], pages: {}, dasThrows: new Set(), dasNoCursor: false, dasCalls: [], wmcError: null, updates: [], wmcUpserts: [], edUpserts: [], rpcs: [], rpcArgs: [] }

vi.mock("@/lib/chains/solana/das", () => ({
  getAssetsByGroupCursor: async (addr: string, cursor: string | null) => {
    state.dasCalls.push(cursor)
    const idx = cursor ? Number(cursor.split("#")[1]) : 0
    if (state.dasThrows.has(`${addr}:${idx + 1}`)) throw new Error("DAS getAssetsByGroup HTTP 502")
    return { items: state.pages[addr]?.[idx] ?? [], total: 0, limit: 1000, page: 0, cursor: state.dasNoCursor ? undefined : `${addr}#${idx + 1}` }
  },
}))
vi.mock("@/lib/chains/solana/escrow", () => ({
  attributeEscrowHeldToSellers: async (_db: any, rows: any[]) => ({ rows, remapped: 0, unmatched: 0, error: null }),
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
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

  it("a spent budget walks nothing and claims nothing", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(5, "x")]
    let t = 0
    const r = await runCollectionsCensus(db(), { budgetMs: 10, now: () => (t += 100) })
    expect(r.cards).toBe(0)
    expect(r.completed).toBe(0)
  })
})
