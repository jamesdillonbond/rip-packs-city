import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/candy/refresh-wallet.ts — the live read behind a pasted Candy address (2026-11-08).
// The property that matters most: a wallet's rows are RETIRED only behind a complete walk.
// An incomplete walk (DAS error, a failed write, a failed escrow read) must retire nothing,
// or a transient failure deletes a collector's holdings.

const state: {
  pages: any[][]
  ownerThrows: boolean
  listings: { data: any[]; error: any }
  assets: Record<string, any>
  upsertError: any
  rpcs: Array<{ name: string; args: any }>
  upserted: any[][]
  knownEditions: string[]
  editionInserts: any[][]
  collections: Record<string, any>
} = { pages: [], ownerThrows: false, listings: { data: [], error: null }, assets: {}, upsertError: null, rpcs: [], upserted: [], knownEditions: [], editionInserts: [], collections: {} }

vi.mock("@/lib/chains/solana/das", () => ({
  getAssetsByOwner: async (_w: string, page: number) => {
    if (state.ownerThrows) throw new Error("DAS getAssetsByOwner HTTP 502")
    return { items: state.pages[page - 1] ?? [], total: 0, limit: 1000, page }
  },
  getAssetBatch: async (ids: string[]) => ids.map((id) => state.collections[id] ?? null),
  getAsset: async (id: string) => {
    if (!(id in state.assets)) throw new Error("no asset " + id)
    return state.assets[id]
  },
}))
vi.mock("@/lib/chains/solana/candy-sets", () => ({ isCandySetAsset: (a: any) => a.candy === true, CANDY_COLLECTION_AUTHORITIES: ["CANDYAUTH"] }))
vi.mock("@/lib/chains/solana/normalize", () => ({
  CANDY_MLB_UUID: "c1",
  isBurnt: (a: any) => a.kind === "burnt",
  isPack: (a: any) => a.kind === "pack",
  normalizeEdition: (a: any) => ({ external_id: a.ed ?? "k", collection_id: "c1", name: a.ed ?? "k" }),
  normalizeSerial: (a: any) => ({ moment_id: a.id, wallet_address: "DAS-OWNER", collection_id: "c1", edition_key: "k", serial_number: 1, image_url: null }),
}))

vi.mock("@/lib/chains/solana/hydrate", () => ({ isUnhydrated: (a: any) => a.bare === true }))
vi.mock("@/lib/candy/collections", () => ({ loadCandyCollections: async () => ({ sets: [{ key: "c:x" }], error: null }) }))

import { refreshCandyWallet } from "@/lib/candy/refresh-wallet"

const ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"
const W = "99UgF7Tt4HPDpJ7mK63kvucts21mhymgWkzu1EjsLjAy"

function db() {
  return {
    rpc: async (name: string, args: any) => {
      state.rpcs.push({ name, args })
      return { data: name === "candy_retire_wallet_unseen" ? 3 : name === "purge_candy_wmc_ghost_rows_for" ? 2 : null, error: null }
    },
    from: (table: string) => {
      if (table === "editions") {
        const b: any = {
          select: () => b, eq: () => b,
          in: async (_c: string, keys: string[]) => ({ data: keys.filter((k) => state.knownEditions.includes(k)).map((k) => ({ external_id: k })), error: null }),
          upsert: (rows: any[], opts: any) => {
            state.editionInserts.push(rows.map((r) => ({ ...r, _ignoreDuplicates: opts?.ignoreDuplicates })))
            return { select: async () => ({ data: rows.map((r) => ({ external_id: r.external_id })), error: null }) }
          },
        }
        return b
      }
      if (table === "candy_listings") {
        const b: any = { select: () => b, eq: () => b, order: () => b, limit: async () => state.listings }
        return b
      }
      return {
        update: (patch: any) => {
          const f: any[] = []
          const u: any = {
            eq: (c: string, v: any) => { f.push([c, v]); return u },
            in: async (_c: string, ids: string[]) => { (state as any).touched.push({ patch, filters: f, ids }); return { error: (state as any).touchError ?? null } },
          }
          return u
        },
        upsert: (rows: any[]) => {
          state.upserted.push(rows)
          return { select: async () => (state.upsertError ? { data: null, error: state.upsertError } : { data: rows.map((r) => ({ moment_id: r.moment_id })), error: null }) }
        },
      }
    },
  }
}

beforeEach(() => {
  ;(state as any).touched = []
  ;(state as any).touchError = null
  state.pages = []
  state.ownerThrows = false
  state.listings = { data: [], error: null }
  state.assets = {}
  state.upsertError = null
  state.rpcs = []
  state.upserted = []
  state.knownEditions = []
  state.editionInserts = []
  state.collections = {}
})

describe("refreshCandyWallet", () => {
  it("writes only Candy cards (no burnt, no packs) under the QUERIED wallet, and retires behind a complete walk", async () => {
    state.pages = [[
      { id: "a", candy: true },
      { id: "b", candy: true, kind: "burnt" },
      { id: "c", candy: true, kind: "pack" },
      { id: "d", candy: false },
    ]]
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(true)
    expect(r.catalog_collections).toBe(1)
    expect(r.found).toBe(1)
    expect(state.upserted.flat().map((x) => x.moment_id)).toEqual(["a"])
    expect(state.upserted.flat()[0].wallet_address).toBe(W)
    const names = state.rpcs.map((x) => x.name)
    expect(names).toContain("candy_retire_wallet_unseen")
    expect(names).toContain("purge_candy_wmc_ghost_rows_for")
    expect(names).not.toContain("purge_candy_wmc_ghost_rows")
    // Scoped to the cards this walk wrote.
    expect(state.rpcs.find((x) => x.name === "purge_candy_wmc_ghost_rows_for")!.args).toEqual({ p_moment_ids: ["a"] })
    expect(r.retired).toBe(3)
    expect(r.ghosts_purged).toBe(2)
  })

  it("a wallet that holds no Candy cards is a COMPLETE walk that retires its old rows (it sold everything)", async () => {
    state.pages = [[{ id: "x", candy: false }]]
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(true)
    expect(r.found).toBe(0)
    expect(state.rpcs.map((x) => x.name)).toContain("candy_retire_wallet_unseen")
  })

  it("a failed DAS walk retires NOTHING and reports itself incomplete", async () => {
    state.ownerThrows = true
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(false)
    expect(r.walk_error).toMatch(/502/)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })

  it("a rejected write retires NOTHING", async () => {
    state.pages = [[{ id: "a", candy: true }]]
    state.upsertError = { message: "deadlock detected" }
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(false)
    expect(r.write_errors.length).toBe(1)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })

  it("a failed listings read retires NOTHING — the wallet's listed cards would otherwise be deleted", async () => {
    state.pages = [[{ id: "a", candy: true }]]
    state.listings = { data: null as any, error: { message: "timeout" } }
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(false)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })

  it("a card the wallet has listed on Magic Eden is written under the wallet while the escrow holds it", async () => {
    state.pages = [[]]
    state.listings = { data: [{ token_mint: "L1" }, { token_mint: "L2" }], error: null }
    state.assets = { L1: { id: "L1", candy: true, ownership: { owner: ESCROW } }, L2: { id: "L2", candy: true, ownership: { owner: "SOMEONE-ELSE" } } }
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(true)
    expect(r.escrow_listed).toBe(1)
    expect(r.escrow_listed_stale).toBe(1)
    expect(state.upserted.flat().map((x) => x.moment_id)).toEqual(["L1"])
    expect(state.upserted.flat()[0].wallet_address).toBe(W)
  })

  it("without retire it never deletes, even after a complete walk", async () => {
    state.pages = [[{ id: "a", candy: true }]]
    const r = await refreshCandyWallet(db(), W)
    expect(r.complete).toBe(true)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })

  it("inserts ONLY editions the catalog has not seen, insert-only (an existing edition is never rewritten)", async () => {
    state.pages = [[{ id: "a", candy: true, ed: "asg26:shohei-ohtani-core" }, { id: "b", candy: true, ed: "shohei-ohtani" }, { id: "c", candy: true, ed: "asg26:shohei-ohtani-core" }]]
    state.knownEditions = ["shohei-ohtani"]
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.editions_inserted).toBe(1)
    const ins = state.editionInserts.flat()
    expect(ins.map((x) => x.external_id)).toEqual(["asg26:shohei-ohtani-core"])
    expect(ins[0]._ignoreDuplicates).toBe(true)
  })

  it("counts the wallet's OTHER Candy collectibles (collection authority = Candy) and ignores everything else it holds", async () => {
    const g = (c: string) => [{ group_key: "collection", group_value: c }]
    state.pages = [[
      { id: "a", candy: true },
      { id: "l1", grouping: g("LEADOFF22") }, { id: "l2", grouping: g("LEADOFF22") }, { id: "l3", grouping: g("LEADOFF22"), kind: "burnt" },
      { id: "p1", grouping: g("PIN23") },
      { id: "x1", grouping: g("SOMEONE_ELSES_NFTS") },
    ]]
    state.collections = {
      LEADOFF22: { id: "LEADOFF22", authorities: [{ address: "CANDYAUTH" }], content: { metadata: { name: "2022 Leadoff ICONs" } } },
      PIN23: { id: "PIN23", authorities: [{ address: "CANDYAUTH" }], content: { metadata: { name: "2023 Opening Day Pin" } } },
      SOMEONE_ELSES_NFTS: { id: "SOMEONE_ELSES_NFTS", authorities: [{ address: "OTHER" }], content: { metadata: { name: "Degens" } } },
    }
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.other_candy).toEqual({ items: 3, collections: [{ name: "2022 Leadoff ICONs", items: 2 }, { name: "2023 Opening Day Pin", items: 1 }] })
    // Untracked Candy collectibles are never written to the cache.
    expect(state.upserted.flat().map((x) => x.moment_id)).toEqual(["a"])
  })

  it("a spent time budget stops the walk as incomplete", async () => {
    state.pages = [[{ id: "a", candy: true }]]
    const r = await refreshCandyWallet(db(), W, { retire: true, deadlineAt: Date.now() - 1 })
    expect(r.complete).toBe(false)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })

  // 2026-11-12 (#246 source): a card DAS returns without metadata is never written under a name-only key —
  // its existing row is only touched (last_seen_at), so retirement keeps it under the key it already has.
  it("never WRITES a metadata-less card; touches its existing row so retirement keeps it", async () => {
    state.pages = [[{ id: "a", candy: true }, { id: "bare1", candy: true, bare: true, ed: "c:x:name-only" }]]
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(state.upserted.flat().map((x) => x.moment_id)).toEqual(["a"])
    expect(state.editionInserts.flat().map((e: any) => e.external_id)).not.toContain("c:x:name-only")
    const t = (state as any).touched
    expect(t).toHaveLength(1)
    expect(t[0].ids).toEqual(["bare1"])
    expect(Object.keys(t[0].patch)).toEqual(["last_seen_at"])
    expect(t[0].filters).toContainEqual(["wallet_address", W])
    expect(r.unhydrated_kept).toBe(1)
    expect(r.complete).toBe(true)
    expect(state.rpcs.map((x) => x.name)).toContain("candy_retire_wallet_unseen")
  })

  it("a failed touch makes the walk INCOMPLETE, so nothing is retired", async () => {
    state.pages = [[{ id: "bare1", candy: true, bare: true }]]
    ;(state as any).touchError = { message: "lock timeout" }
    const r = await refreshCandyWallet(db(), W, { retire: true })
    expect(r.complete).toBe(false)
    expect(state.rpcs.map((x) => x.name)).not.toContain("candy_retire_wallet_unseen")
  })
})
