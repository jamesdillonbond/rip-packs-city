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
  editionGroupKey: (a: any) => `g|${a.id}`,
  hydrateFromJsonUri: async (assets: any[]) => {
    state.hydrateCalls.push(assets)
    if (typeof state.hydrate === "function") return state.hydrate(assets)
    return state.hydrate ?? { hydrated: assets.map((a) => ({ ...a, bare: false, ed: a.realEd ?? a.ed })), failed: [] }
  },
}))
vi.mock("@/lib/chains/solana/escrow", () => ({
  attributeEscrowHeldToSellers: async (_db: any, rows: any[]) =>
    (state as any).escrowError
      ? { rows, remapped: 0, unmatched: 1, error: (state as any).escrowError }
      : { rows, remapped: 0, unmatched: 0, error: null },
}))
vi.mock("@/lib/chains/solana/normalize", () => ({
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
  CANDY_MLB_UUID: "c1",
  normalizeEdition: (a: any) => ({ external_id: "ed-" + a.ed, collection_id: "c1", player_name: "Seth Brown", team_name: "Athletics", set_name: "2022 Leadoff ICONs", tier: "COMMON", circulation_count: 850, thumbnail_url: a.noThumb ? null : (state as any).thumb }),
  normalizeSerial: (a: any) => ({ moment_id: a.id, wallet_address: a.owner, collection_id: "c1", edition_key: "ed-" + a.ed, serial_number: 1, image_url: null }),
}))
vi.mock("@/lib/chains/solana/candy-sets", () => ({ candySetForAsset: () => ({ key: "c:x" }) }))
vi.mock("@/lib/candy/collections", () => ({ loadCandyCollections: async () => ({ sets: [], error: null }) }))

import { runCollectionsCensus } from "@/lib/candy/collections-census"

const full = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, owner: "W", ed: "a" }))

function db() {
  return {
    rpc: async (name: string, args: any) => {
      state.rpcs.push(name); state.rpcArgs.push(args)
      if (name === "candy_repoint_listings_to_card_edition" && (state as any).listingsError) return { data: null, error: (state as any).listingsError }
      if (name === "candy_retire_noncard_wmc") {
        const gone = state.existingWmc.filter((r) => args.p_moment_ids.includes(r.moment_id))
        ;(state as any).deleted.push(...gone)
        state.existingWmc = state.existingWmc.filter((r) => !args.p_moment_ids.includes(r.moment_id))
        return { data: gone.length, error: null }
      }
      if (name === "candy_retire_unseen_labelless_wmc") {
        // mirrors the SQL function: still-thumbnail-less keys only; refuse (delete nothing) over the cap
        const live = (args.p_edition_keys as string[]).filter((k) => state.existingEds.some((e) => e.external_id === k && e.thumbnail_url == null))
        const rows = state.existingWmc.filter((r) => live.includes(r.edition_key))
        if (rows.length > args.p_max_rows) return { data: { retired: 0, rows: rows.length, refused: true }, error: null }
        ;(state as any).deleted.push(...rows)
        state.existingWmc = state.existingWmc.filter((r) => !live.includes(r.edition_key))
        return { data: { retired: rows.length, rows: rows.length, refused: false }, error: null }
      }
      return { data: 4, error: null }
    },
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
        select: (_cols?: string, opts?: any) => {
          const q: any = {
            eq: () => q,
            is: () => q,
            // RETIRE's editions read: thumbnail-less editions under a prefix
            like: async (_c: string, pat: string) => {
              const pre = pat.replace(/%$/, "")
              // RETIRE's completeness count: holdings rows under the collection's prefix
              if (t === "wallet_moments_cache" && opts?.head) return { count: state.existingWmc.filter((r) => r.edition_key.startsWith(pre)).length, error: null }
              return { data: state.existingEds.filter((e) => e.thumbnail_url == null && e.external_id.startsWith(pre)), error: null }
            },
            in: async (col: string, vals: string[]) => {
              if (state.readError) return { data: null, error: state.readError }
              if (t === "wallet_moments_cache" && opts?.head) return { count: state.existingWmc.filter((r) => vals.includes(r.edition_key)).length, error: null }
              if (t === "wallet_moments_cache") return { data: state.existingWmc.filter((r) => vals.includes(r.moment_id)), error: null }
              return { data: state.existingEds.filter((e) => vals.includes(e.external_id)), error: null }
            },
          }
          return q
        },
        delete: () => {
          const d: any = { eq: () => d, in: (_c: string, vals: string[]) => ({ select: async () => {
            const gone = state.existingWmc.filter((r) => vals.includes(r.edition_key))
            ;(state as any).deleted.push(...gone)
            state.existingWmc = state.existingWmc.filter((r) => !vals.includes(r.edition_key))
            return { data: gone.map((r) => ({ moment_id: r.moment_id })), error: null }
          } }) }
          return d
        },
        update: (patch: any) => {
          const f: any = { filters: [] as any[] }
          const u: any = {
            eq: (c: string, v: any) => { f.filters.push(["eq", c, v]); return u },
            is: (c: string, v: any) => { f.filters.push(["is", c, v]); return u },
            select: async () => {
              ;(state as any).edUpdates.push({ table: t, patch, filters: f.filters })
              const key = f.filters.find((x: any[]) => x[1] === "external_id")?.[2]
              const row = state.existingEds.find((e) => e.external_id === key)
              const guarded = f.filters.some((x: any[]) => x[0] === "is" && x[1] === "thumbnail_url" && x[2] === null)
              if (!row || !guarded || row.thumbnail_url) return { data: [], error: null }
              Object.assign(row, patch)
              return { data: [{ external_id: key }], error: null }
            },
          }
          return u
        },
        upsert: (rows: any[], opts: any) => {
          if (t === "wallet_moments_cache") state.wmcUpserts.push({ rows, opts })
          else state.edUpserts.push({ rows, opts })
          return { select: async () => {
            if (t === "wallet_moments_cache" && (state as any).wmcErrOnce?.length) return { data: null, error: (state as any).wmcErrOnce.shift() }
            return t === "wallet_moments_cache" && state.wmcError ? { data: null, error: state.wmcError } : { data: rows.map((r) => ({ moment_id: r.moment_id, external_id: r.external_id })), error: null }
          } }
        },
      }
    },
  }
}

beforeEach(() => {
  state.queue = []; state.pages = {}; state.dasThrows = new Set(); state.dasNoCursor = false; state.dasCalls = []; state.wmcError = null
  ;(state as any).listingsError = null
  state.existingWmc = []; state.existingEds = []; state.readError = null; state.hydrate = null; state.hydrateCalls = []
  state.updates = []; state.wmcUpserts = []; state.edUpserts = []; state.rpcs = []; state.rpcArgs = []
  ;(state as any).wmcErrOnce = []
  ;(state as any).edUpdates = []; (state as any).thumb = "https://arweave.net/x"; (state as any).deleted = []; (state as any).escrowError = null
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
    // the second page was asked BY CURSOR, not by page number; DAS handed a cursor on the short page, so it was
    // followed to an empty page before the walk ended (2026-11-13: a short page alone does not end a walk)
    expect(state.dasCalls).toEqual([null, "A#1", "A#2"])
    expect(typeof last.last_census_at).toBe("string")
    // The ghost purge is SCOPED to the moments this run inserted — never the unscoped
    // whole-collection rank that timed out at 120 s on 1.4M rows.
    expect(state.rpcs).toEqual(["purge_candy_wmc_ghost_rows_for"])
    expect(new Set(state.rpcArgs[0].p_moment_ids)).toEqual(new Set([...full(1000, "p1-"), ...full(3, "p2-")].map((x) => x.id)))
    // Holdings are born labelled — never left for a whole-collection denorm.
    expect(state.wmcUpserts[0].rows[0]).toMatchObject({ tier: "COMMON", player_name: "Seth Brown", set_name: "2022 Leadoff ICONs", mint_count: 850, team_name: "Athletics" })
  })

  // 2026-11-13: ending on any short page would stamp a walk complete (and run RETIRE) when DAS returned a short page
  // mid-collection with a cursor to more. The walk ends on an empty page, or a short page with no cursor.
  it("a short page WITH a cursor is followed: the cards after it are walked, not dropped", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(1000, "p1-"), full(400, "p2-"), full(7, "p3-"), []]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.cards).toBe(1407)
    expect(state.dasCalls).toEqual([null, "A#1", "A#2", "A#3"])
    expect(state.updates.filter((u) => u.address === "A").at(-1)!.patch).toMatchObject({ census_page: 1, census_cursor: null, last_census_items: 1407 })
  })

  it("a short page with NO cursor ends the walk without an extra call", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(5, "p1-"), full(9, "never-")]
    state.dasNoCursor = true
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.cards).toBe(5)
    expect(state.dasCalls).toEqual([null])
    expect(r.completed).toBe(1)
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
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000, lockSleep: async () => {} })
    expect(r.ok).toBe(false)
    expect(state.updates.some((u) => u.patch.census_page !== undefined)).toBe(false)
  })

  it("a resumed walk keeps going from its saved CURSOR and reports its item count as unknown", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), full(5, "y")]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.cards).toBe(5)
    expect(state.dasCalls).toEqual(["A#1", "A#2"])
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
    expect(state.dasCalls).toEqual([null, "A#1", "A#2"])
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

  // 2026-11-09: a name-keyed 1/1 edition merged different cards (Tricons; Bat Cowl 4,404).
  it("⚠ NO REUSE of a 1-of-1 edition that is not this card's own key — the card is fetched and re-keyed", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "merged", realEd: "own", bare: true }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-merged", serial_number: 1 }]
    state.existingEds = [{ external_id: "ed-merged", tier: null, player_name: null, team_name: null, set_name: "Tricons", circulation_count: 1, thumbnail_url: "https://img" }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.hydrated_reused).toBe(0)
    expect(state.hydrateCalls.flat().map((a) => a.id)).toEqual(["m1"])
    const overwrite = state.wmcUpserts.find((u) => u.opts.ignoreDuplicates === false)!
    expect(overwrite.rows[0]).toMatchObject({ moment_id: "m1", edition_key: "ed-own" })
  })

  it("a 1-of-1 edition that IS this card's own key is still reused, with no fetch", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_cursor: null, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1234567890123", owner: "W", ed: "x", bare: true }]]
    state.existingWmc = [{ moment_id: "m1234567890123", wallet_address: "W", edition_key: "ed-tricon-m12345678901", serial_number: 1 }]
    state.existingEds = [{ external_id: "ed-tricon-m12345678901", tier: null, player_name: null, team_name: null, set_name: "Tricons", circulation_count: 1, thumbnail_url: "https://img" }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.hydrated_reused).toBe(1)
    expect(state.hydrateCalls).toEqual([])
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
    // its listings follow it: one set-based call with the repointed mints
    const lr = state.rpcs.indexOf("candy_repoint_listings_to_card_edition")
    expect(lr).toBeGreaterThanOrEqual(0)
    expect(state.rpcArgs[lr]).toEqual({ p_mints: ["m1"] })
    expect(r.listings_repointed).toBe(4) // the rpc mock answers 4
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

  it("a failed LISTINGS repoint fails the page and does not advance the cursor", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-08T00:00:00Z" }]
    state.pages.A = [full(1000, "x"), [{ id: "m1", owner: "W", ed: "name-only", realEd: "real", bare: true }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-name-only", serial_number: null }]
    ;(state as any).listingsError = { message: "statement timeout" }
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/listings repoint: statement timeout/)
    expect(state.updates.some((u) => u.patch.census_page !== undefined)).toBe(false)
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

  // 2026-11-12 (#246 residual): 690 editions written label-less from unhydrated cards before
  // the 11-09 fix kept 51,318 correctly-keyed cards on a thumbnail-less row, because the
  // insert-only edition upsert discarded the labels every later hydrated card computed.
  it("FILLS a label-less edition the page's hydrated cards key to — NULL labels only, guarded on thumbnail IS NULL", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "a" }, { id: "m2", owner: "W", ed: "a" }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-a", serial_number: 1 }, { moment_id: "m2", wallet_address: "W", edition_key: "ed-a", serial_number: 2 }]
    state.existingEds = [{ external_id: "ed-a", tier: null, player_name: "Kept Name", team_name: null, set_name: null, circulation_count: null, thumbnail_url: null, video_url: null }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.editions_filled).toBe(1)
    expect(r.wmc_repointed).toBe(0)
    const ups = (state as any).edUpdates
    expect(ups).toHaveLength(1)
    // a present label is NEVER overwritten — only NULLs are filled
    expect(ups[0].patch).toEqual({ thumbnail_url: "https://arweave.net/x", circulation_count: 850, tier: "COMMON", team_name: "Athletics" })
    expect(ups[0].patch).not.toHaveProperty("player_name")
    expect(ups[0].filters).toContainEqual(["is", "thumbnail_url", null])
    expect(state.existingEds[0]).toMatchObject({ thumbnail_url: "https://arweave.net/x", player_name: "Kept Name", circulation_count: 850 })
  })

  it("does NOT fill from a computed edition that itself has no thumbnail, and never touches a complete edition", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "a", noThumb: true }, { id: "m2", owner: "W", ed: "b" }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "ed-a", serial_number: 1 }, { moment_id: "m2", wallet_address: "W", edition_key: "ed-b", serial_number: 1 }]
    state.existingEds = [
      { external_id: "ed-a", tier: null, player_name: null, team_name: null, set_name: null, circulation_count: null, thumbnail_url: null, video_url: null },
      { external_id: "ed-b", tier: null, player_name: null, team_name: null, set_name: null, circulation_count: 10, thumbnail_url: "https://arweave.net/old", video_url: null },
    ]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.editions_filled).toBe(0)
    expect((state as any).edUpdates).toHaveLength(0)
    expect(state.existingEds[1].thumbnail_url).toBe("https://arweave.net/old")
  })

  // 2026-11-12 (#246 residual): Aquaman (2025-) #3 held 360 rows against a 350-card walk — the 10 extra were
  // exactly the fabricated label-less edition's, cards DAS no longer returns. The add-only census never retired them.
  describe("RETIRE — rows on a label-less edition no card of a clean walk resolved to", () => {
    const setup = () => {
      state.queue = [{ address: "A", name: "Aquaman", edition_prefix: "c:aq", census_page: 1, census_walk_started_at: null }]
      state.pages.A = [[{ id: "m1", owner: "W", ed: "c:aq:real" }, { id: "m2", owner: "W", ed: "c:aq:real" }, { id: "m3", owner: "W", ed: "c:aq:real" }, { id: "m4", owner: "W", ed: "c:aq:real" }]]
      state.existingWmc = [
        { moment_id: "m1", wallet_address: "W", edition_key: "ed-c:aq:real", serial_number: 1 },
        { moment_id: "gone1", wallet_address: "X", edition_key: "c:aq:fabricated", serial_number: null },
        { moment_id: "gone2", wallet_address: "Y", edition_key: "c:aq:fabricated", serial_number: null },
      ]
      state.existingEds = [
        { external_id: "ed-c:aq:real", thumbnail_url: "https://arweave.net/r", circulation_count: 100, tier: "RARE" },
        { external_id: "c:aq:fabricated", thumbnail_url: null, circulation_count: null, tier: null },
      ]
    }
    it("deletes them after a clean complete walk started in this run, and counts them", async () => {
      setup()
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(true)
      expect(r.wmc_retired).toBe(2)
      expect((state as any).deleted.map((x: any) => x.moment_id).sort()).toEqual(["gone1", "gone2"])
      // the walked card's row is untouched
      expect(state.existingWmc.map((x) => x.moment_id)).toContain("m1")
    })
    it("fails OPEN on a walk resumed from an earlier run (it did not see the whole collection)", async () => {
      setup()
      state.queue[0] = { ...state.queue[0], census_page: 2, census_cursor: "A#0", census_walk_started_at: "2026-11-12T00:00:00Z" }
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
    })
    it("never retires a label-less edition a card of this walk RESOLVED to (it was seen, just not filled)", async () => {
      setup()
      ;(state as any).thumb = null // computed editions carry no thumbnail → no FILL
      state.pages.A = [[...state.pages.A[0], { id: "seen1", owner: "X", ed: "c:aq:fabricated-x" }]]
      state.existingEds.push({ external_id: "ed-c:aq:fabricated-x", thumbnail_url: null, circulation_count: null, tier: null })
      state.existingWmc.push({ moment_id: "seen1", wallet_address: "X", edition_key: "ed-c:aq:fabricated-x", serial_number: null })
      state.queue[0].edition_prefix = "ed-c:aq"
      // control: an UNSEEN label-less edition under the same prefix IS retired in the same walk
      state.existingEds.push({ external_id: "ed-c:aq:unseen", thumbnail_url: null, circulation_count: null, tier: null })
      state.existingWmc.push({ moment_id: "u1", wallet_address: "Q", edition_key: "ed-c:aq:unseen", serial_number: null })
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(true)
      expect((state as any).deleted.map((x: any) => x.edition_key)).toEqual(["ed-c:aq:unseen"])
      expect(state.existingWmc.find((x) => x.moment_id === "seen1")?.edition_key).toBe("ed-c:aq:fabricated-x")
    })
    it("REFUSES (and fails the run) when the unseen rows exceed the cap against the walk", async () => {
      setup()
      for (let i = 0; i < 40; i++) state.existingWmc.push({ moment_id: `g${i}`, wallet_address: "Z", edition_key: "c:aq:fabricated", serial_number: null })
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(false)
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
      expect(r.error).toMatch(/retire: refused/)
    })
  })

  // 2026-11-12: the 3:57 PM PT run failed on a wmc "lock timeout" (2022 Play of the Day, page 25).
  it("a holdings write that hits a lock timeout once is RETRIED and the run stays ok", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [full(3, "z")]
    ;(state as any).wmcErrOnce = [{ message: "canceling statement due to lock timeout", code: "55P03" }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000, lockSleep: async () => {} })
    expect(r.ok).toBe(true)
    expect(r.wmc_inserted).toBe(3)
  })

  // 2026-11-12: a walk spanning runs keeps its label-less seen keys + skip count on candy_collections.
  describe("CROSS-RUN record — RETIRE at the end of a walk that spanned runs", () => {
    const base = () => {
      state.pages.A = [[], [{ id: "m1", owner: "W", ed: "c:aq:real" }]]
      state.existingWmc = [
        { moment_id: "m1", wallet_address: "W", edition_key: "ed-c:aq:real", serial_number: 1 },
        { moment_id: "seenEarlier", wallet_address: "X", edition_key: "c:aq:seen-earlier", serial_number: null },
        { moment_id: "gone", wallet_address: "Y", edition_key: "c:aq:fabricated", serial_number: null },
      ]
      state.existingEds = [
        { external_id: "ed-c:aq:real", thumbnail_url: "https://arweave.net/r", circulation_count: 100, tier: "RARE" },
        { external_id: "c:aq:seen-earlier", thumbnail_url: null, circulation_count: null, tier: null },
        { external_id: "c:aq:fabricated", thumbnail_url: null, circulation_count: null, tier: null },
      ]
    }
    it("a TRACKED resumed walk retires the unseen key and keeps the key an earlier run saw", async () => {
      base()
      state.queue = [{ address: "A", name: "A", edition_prefix: "c:aq", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-12T20:00:00Z",
        census_walk_tracked: true, census_walk_labelless_seen: ["c:aq:seen-earlier"], census_walk_skipped: 0, census_walk_cards: 40 }]
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(true)
      expect((state as any).deleted.map((x: any) => x.edition_key)).toEqual(["c:aq:fabricated"])
      expect(state.existingWmc.some((x) => x.moment_id === "seenEarlier")).toBe(true)
      // the finished walk resets its record
      expect(state.updates.filter((u) => u.address === "A").at(-1)!.patch).toMatchObject({ census_walk_tracked: false, census_walk_labelless_seen: [], census_walk_skipped: 0 })
    })
    it("an UNTRACKED resumed walk (begun before this code) retires nothing", async () => {
      base()
      state.queue = [{ address: "A", name: "A", edition_prefix: "c:aq", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-12T20:00:00Z" }]
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
    })
    it("a tracked walk that SKIPPED a card in an earlier run retires nothing", async () => {
      base()
      state.queue = [{ address: "A", name: "A", edition_prefix: "c:aq", census_page: 2, census_cursor: "A#1", census_walk_started_at: "2026-11-12T20:00:00Z",
        census_walk_tracked: true, census_walk_labelless_seen: [], census_walk_skipped: 2, census_walk_cards: 40 }]
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
    })
    it("each unfinished page persists the label-less keys it resolved and the cumulative counts", async () => {
      state.queue = [{ address: "A", name: "A", edition_prefix: "ed-c:aq", census_page: 1, census_walk_started_at: null }]
      ;(state as any).thumb = null
      state.pages.A = [full(1000, "p").map((a: any) => ({ ...a, ed: "c:aq:lab" })), []]
      state.existingEds = [{ external_id: "ed-c:aq:lab", thumbnail_url: null, circulation_count: null, tier: null }]
      await runCollectionsCensus(db(), { budgetMs: 60_000 })
      const mid = state.updates.find((u) => u.address === "A" && u.patch.census_page === 2)!.patch
      expect(mid.census_walk_labelless_seen).toEqual(["ed-c:aq:lab"])
      expect(mid.census_walk_cards).toBe(1000)
      expect(mid.census_walk_skipped).toBe(0)
    })
  })

  // 2026-11-13 (independent review): a multi-run walk must not retire the holdings it wrote itself.
  describe("the cross-run record covers editions created mid-walk, and a capped read retires nothing", () => {
    it("a thumbnail-less edition this run CREATES is recorded for the walk's later runs", async () => {
      state.queue = [{ address: "A", name: "A", edition_prefix: "ed-c:aq", census_page: 1, census_walk_started_at: null }]
      // page 1 is full (the walk continues next run); its cards resolve to a NEW edition with no image
      state.pages.A = [full(1000, "p").map((a: any) => ({ ...a, ed: "c:aq:new", noThumb: true })), []]
      state.existingEds = []
      await runCollectionsCensus(db(), { budgetMs: 60_000 })
      const mid = state.updates.find((u) => u.address === "A" && u.patch.census_page === 2)!.patch
      expect(mid.census_walk_labelless_seen).toContain("ed-c:aq:new")
    })

    it("a new edition WITH a thumbnail is not recorded (control: the record stays label-less only)", async () => {
      state.queue = [{ address: "A", name: "A", edition_prefix: "ed-c:aq", census_page: 1, census_walk_started_at: null }]
      state.pages.A = [full(1000, "p").map((a: any) => ({ ...a, ed: "c:aq:new" })), []]
      state.existingEds = []
      await runCollectionsCensus(db(), { budgetMs: 60_000 })
      const mid = state.updates.find((u) => u.address === "A" && u.patch.census_page === 2)!.patch
      expect(mid.census_walk_labelless_seen).toEqual([])
    })

    it("a label-less read that hits the 1,000-row cap is an unknown record: the walk retires nothing", async () => {
      state.queue = [{ address: "A", name: "A", edition_prefix: "c:cap", census_page: 1, census_walk_started_at: null }]
      state.pages.A = [Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, owner: "W", ed: "c:cap:real" }))]
      state.existingEds = Array.from({ length: 1000 }, (_, i) => ({ external_id: `c:cap:ghost-${i}`, thumbnail_url: null, circulation_count: null, tier: null }))
      state.existingWmc = [{ moment_id: "g0", wallet_address: "X", edition_key: "c:cap:ghost-0", serial_number: null }]
      await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(state.rpcs).not.toContain("candy_retire_unseen_labelless_wmc")
      expect((state as any).deleted).toHaveLength(0)
    })
  })

  // 2026-11-12, Absolute Batman (2024-) #2: 267 burnt cards on the fabricated key vs a 718-card walk that
  // matched the 718 rows on every other edition. The 25 % cap refused a correct retire.
  describe("RETIRE over the share cap — allowed only when the walk saw everything else we hold", () => {
    const setup = (walked: number, otherHeld: number, unseen: number) => {
      state.queue = [{ address: "A", name: "AB2", edition_prefix: "c:ab", census_page: 1, census_walk_started_at: null }]
      state.pages.A = [Array.from({ length: walked }, (_, i) => ({ id: `w${i}`, owner: "W", ed: "c:ab:real" }))]
      state.existingEds = [
        { external_id: "ed-c:ab:real", thumbnail_url: "https://arweave.net/r", circulation_count: 100, tier: "RARE" },
        { external_id: "c:ab:fabricated", thumbnail_url: null, circulation_count: null, tier: null },
      ]
      state.existingWmc = [
        ...Array.from({ length: otherHeld }, (_, i) => ({ moment_id: `w${i}`, wallet_address: "W", edition_key: "c:ab:real-held", serial_number: 1 })),
        ...Array.from({ length: unseen }, (_, i) => ({ moment_id: `g${i}`, wallet_address: `X${i}`, edition_key: "c:ab:fabricated", serial_number: null })),
      ]
    }
    it("a walk that accounts for every other row it holds retires the unseen rows even above 25 %", async () => {
      setup(40, 40, 15)
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(true)
      expect(r.wmc_retired).toBe(15)
    })
    // 2026-11-13 (review): a failed escrow-seller lookup leaves listed cards on the escrow address — the walk can
    // no longer vouch for who holds them, so it must not retire (control: the case above retires 15).
    it("a walk whose escrow-seller lookup FAILED retires nothing", async () => {
      setup(40, 40, 15)
      ;(state as any).escrowError = "candy_listings: statement timeout"
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
      expect(state.rpcs).not.toContain("candy_retire_unseen_labelless_wmc")
    })
    it("a SHORT walk (saw 20 of 40 rows held elsewhere) still refuses — nothing deleted, run fails", async () => {
      setup(20, 40, 15)
      const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
      expect(r.ok).toBe(false)
      expect(r.wmc_retired).toBe(0)
      expect((state as any).deleted).toHaveLength(0)
      expect(r.error).toMatch(/walk saw 20 of 40 rows held outside them/)
    })
  })

  it("a walk that returned NO cards retires nothing and does not fail the run (it confirms nothing)", async () => {
    state.queue = [{ address: "A", name: "Overdrive", edition_prefix: "c:od", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [[]]
    state.existingEds = [{ external_id: "c:od:reward-pack", thumbnail_url: null, circulation_count: null, tier: null }]
    state.existingWmc = Array.from({ length: 24 }, (_, i) => ({ moment_id: `o${i}`, wallet_address: `W${i}`, edition_key: "c:od:reward-pack", serial_number: null }))
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    expect(r.wmc_retired).toBe(0)
    expect((state as any).deleted).toHaveLength(0)
    expect(r.collections[0].retire_note).toMatch(/no cards/)
  })

  // 2026-11-12, Overdrive Rewards: 24 reward PACKS stored as cards on 11-08; every walk hydrated them and wrote 0 cards.
  it("retires the holdings rows of assets the walk SAW as packs or burnt — and only those", async () => {
    state.queue = [{ address: "A", name: "Overdrive", edition_prefix: "c:od", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [[
      { id: "pk1", owner: "W1", ed: "a", kind: "pack" },
      { id: "bt1", owner: "W2", ed: "a", kind: "burnt" },
      { id: "pk2", owner: "W3", ed: "a", kind: "pack" }, // no row held → nothing to retire
      { id: "c1", owner: "W4", ed: "a" },
      { id: "u1", owner: "W5", ed: "a", kind: "pack", bare: true }, // hydration FAILS → never classified
    ]]
    state.hydrate = { hydrated: [], failed: [{ id: "u1", reason: "404" }] }
    state.existingWmc = [
      { moment_id: "pk1", wallet_address: "W1", edition_key: "c:od:reward-pack", serial_number: null },
      { moment_id: "bt1", wallet_address: "W2", edition_key: "ed-a", serial_number: 1 },
      { moment_id: "c1", wallet_address: "W4", edition_key: "ed-a", serial_number: 2 },
      { moment_id: "u1", wallet_address: "W5", edition_key: "c:od:reward-pack", serial_number: null },
    ]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.wmc_noncard_retired).toBe(2)
    expect((state as any).deleted.map((x: any) => x.moment_id).sort()).toEqual(["bt1", "pk1"])
    expect(state.existingWmc.map((x) => x.moment_id)).toEqual(expect.arrayContaining(["c1", "u1"]))
  })

  // 2026-11-12: 263 historical offers kept 43 emptied #246 editions "referenced" — offers follow their card too.
  it("a repointed card moves its OFFERS as well as its listings; a failed offers move fails the page", async () => {
    state.queue = [{ address: "A", name: "A", census_page: 1, census_walk_started_at: null }]
    state.pages.A = [[{ id: "m1", owner: "W", ed: "a" }]]
    state.existingWmc = [{ moment_id: "m1", wallet_address: "W", edition_key: "c:x:fabricated", serial_number: 1 }]
    const r = await runCollectionsCensus(db(), { budgetMs: 60_000 })
    expect(r.ok).toBe(true)
    const i = state.rpcs.indexOf("candy_repoint_offers_to_card_edition")
    expect(i).toBeGreaterThan(-1)
    expect(state.rpcArgs[i]).toEqual({ p_mints: ["m1"] })
    expect(r.offers_repointed).toBe(4)
  })
})
