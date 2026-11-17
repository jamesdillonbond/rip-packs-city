import { describe, it, expect, vi, afterEach } from "vitest"
import {
  parseNftList,
  mapOpenNode,
  parseOpensPage,
  nameGolazosPulls,
  type PackOpenRow,
} from "../supabase/functions/_shared/pack-opens-walker"
import { runHeadSweepWalk } from "../supabase/functions/_shared/head-sweep-walker"

// Pins the Golazos pack-opens ingest (ingest-golazos-pack-opens, 2026-09-23):
// RPC held ZERO Golazos pack opens while Dapper's PackNFT index answers 78,825.

const PREFIX = "A.87ca73a41bb50ad5.Golazos"

afterEach(() => vi.unstubAllGlobals())

describe("parseNftList", () => {
  it("keeps only this contract's NFT ids", () => {
    expect(parseNftList(`${PREFIX}.669051632,${PREFIX}.669131235,A.e4cf4bdc1751c65d.AllDay.5`, PREFIX)).toEqual([
      "669051632",
      "669131235",
    ])
  })
  it("reads a missing list as no pulls, not as an error", () => {
    expect(parseNftList(null, PREFIX)).toEqual([])
    expect(parseNftList("", PREFIX)).toEqual([])
  })
})

describe("mapOpenNode", () => {
  it("maps an opened pack and prefixes the owner address", () => {
    const r = mapOpenNode({
      id: "1", dist_id: "1", status: "Opened", owner_address: "a5ae27cca6fb50e2",
      nfts: `${PREFIX}.1,${PREFIX}.2,${PREFIX}.3,${PREFIX}.4`,
      updated_at: { block_time: "2022-10-26T23:38:17Z", block_height: "100", transaction_hash: "ef" },
    }, PREFIX)
    expect(r).toEqual({
      pack_nft_id: "1", dist_id: "1", opener_address: "0xa5ae27cca6fb50e2",
      opened_at: "2022-10-26T23:38:17Z", open_tx: "ef", open_block: 100,
      nft_ids: ["1", "2", "3", "4"], moments_pulled: 4,
    })
  })
  it("never attributes an open to a CUSTODIAN account (Pinnacle's contract owns every opened pack)", () => {
    const r = mapOpenNode({
      id: "5", dist_id: "8743", status: "Opened", owner_address: "edf9df96c92f4595",
      nfts: "A.edf9df96c92f4595.Pinnacle.16492677151459", updated_at: { block_time: "2026-08-21T14:07:01Z" },
    }, "A.edf9df96c92f4595.Pinnacle", "0xedf9df96c92f4595")
    expect(r?.opener_address).toBeNull()
    expect(r?.nft_ids).toEqual(["16492677151459"])
  })
  it("refuses a pack that is not Opened (a sealed pack is not an open)", () => {
    expect(mapOpenNode({ id: "9", status: "Sealed" }, PREFIX)).toBeNull()
  })
})

describe("parseOpensPage", () => {
  it("dedupes a page on pack_nft_id", () => {
    const n = { id: "1", status: "Opened", nfts: `${PREFIX}.5` }
    const p = parseOpensPage({ totalCount: 2, edges: [{ node: n }, { node: n }], pageInfo: { hasNextPage: false } }, PREFIX)
    expect(p.rows).toHaveLength(1)
    expect(p.totalCount).toBe(2)
  })
})

describe("nameGolazosPulls", () => {
  it("names pulls by edition and leaves an id the index did not return UNNAMED (null), never guessed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { searchGolazosNft: { edges: [{ node: { id: "11", serial_number: "7", edition: { id: "244" } } }] } },
    }))))
    const rows: PackOpenRow[] = [{
      pack_nft_id: "p1", dist_id: "1", opener_address: null, opened_at: null, open_tx: null, open_block: null,
      nft_ids: ["11", "12"], moments_pulled: 2,
    }]
    const r = await nameGolazosPulls(rows, {})
    expect(r.error).toBeNull()
    expect(r.pulls).toEqual([
      { nft_id: "11", pack_nft_id: "p1", edition_external_id: "244", serial_number: 7 },
      { nft_id: "12", pack_nft_id: "p1", edition_external_id: null, serial_number: null },
    ])
  })
  it("a failed lookup is an error for the page, not an empty naming", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })))
    const r = await nameGolazosPulls([{
      pack_nft_id: "p1", dist_id: null, opener_address: null, opened_at: null, open_tx: null, open_block: null,
      nft_ids: ["11"], moments_pulled: 1,
    }], {})
    expect(r.error).toMatch(/HTTP 400/)
    expect(r.pulls).toEqual([])
  })
})

describe("runHeadSweepWalk over opens", () => {
  it("lands new opens at the head while the sweep is latched done", async () => {
    const all: PackOpenRow[] = Array.from({ length: 6 }, (_, i) => ({
      pack_nft_id: String(100 - i), dist_id: "400", opener_address: null, opened_at: null, open_tx: null,
      open_block: null, nft_ids: [], moments_pulled: 0,
    }))
    const stored = new Set(all.slice(2).map((r) => r.pack_nft_id))
    const r = await runHeadSweepWalk<PackOpenRow>({
      fetchPage: async (after) => {
        const s = after == null ? 0 : Number(after)
        const rows = all.slice(s, s + 2)
        return { ok: true, page: { totalCount: 6, endCursor: String(s + rows.length), hasNextPage: s + 2 < 6, rows } }
      },
      keyOf: (o) => o.pack_nft_id,
      existingKeys: async (rows) => ({ keys: new Set(rows.map((o) => o.pack_nft_id).filter((k) => stored.has(k))), error: null }),
      upsert: async (rows) => { rows.forEach((o) => stored.add(o.pack_nft_id)); return null },
      readCursor: async () => ({ after: "6", done: true, error: null }),
      writeCursor: async () => null,
      sleep: async () => {},
    }, { headPages: 5, totalPages: 10, reset: false })
    expect(r.ok).toBe(true)
    expect(r.head_new).toBe(2)
    expect(r.head_pages).toBe(2)
    expect(r.sweep_skipped_done).toBe(true)
  })
})
