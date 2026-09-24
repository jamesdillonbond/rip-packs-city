import { describe, it, expect, vi, afterEach } from "vitest"
import {
  mapEdgeToRow,
  parsePage,
  shouldContinueHead,
  runPackSalesWalk,
  makeStudioFetch,
  type PackSaleRow,
  type PageResult,
  type WalkerDeps,
} from "../supabase/functions/_shared/pack-sales-walker"

// Pins the head-first pack-sales walker shared by backfill-{topshot,allday,golazos}-pack-sales.
//
// The defect it replaced: a single history cursor that walked ~595k Top Shot
// sales (≈7.5 h) before a NEW sale could land, so pack sales history ran a
// mean 5.2 h (Top Shot) / 11.1 h (All Day) behind the chain on 2026-09-23.

function sale(i: number, t = `2026-09-23T00:${String(59 - (i % 60)).padStart(2, "0")}:00Z`): PackSaleRow {
  return {
    tx_hash: `tx${i}`, pack_nft_id: `n${i}`, listing_resource_id: null, sale_price_usd: 1,
    purchased: true, buyer_address: null, storefront_address: null, custom_id: null,
    dist_id: "1", nft_status: "Sealed", block_height: i, block_time: t,
  }
}

/** A fake API: `history[0]` is the newest sale; pages of `size`, cursor = index. */
function fakeApi(history: PackSaleRow[], size = 3) {
  const calls: (string | null)[] = []
  const fetchPage = async (after: string | null): Promise<PageResult> => {
    calls.push(after)
    const start = after == null ? 0 : Number(after)
    const rows = history.slice(start, start + size)
    const end = start + rows.length
    return { ok: true, page: { totalCount: history.length, endCursor: String(end), hasNextPage: end < history.length, rows } }
  }
  return { fetchPage, calls }
}

function fakeStore(initial: PackSaleRow[], cursor: { after: string | null; done: boolean }) {
  const stored = new Map(initial.map((r) => [r.tx_hash + "|" + r.pack_nft_id, r]))
  const state = { cursor: { ...cursor }, cursorWrites: 0 }
  const deps: Omit<WalkerDeps, "fetchPage" | "keyOf" | "timeOf"> = {
    existingKeys: async (rows) => ({ keys: new Set(rows.map((r) => r.tx_hash + "|" + r.pack_nft_id).filter((k) => stored.has(k))), error: null }),
    upsert: async (rows) => { for (const r of rows) stored.set(r.tx_hash + "|" + r.pack_nft_id, r); return null },
    readCursor: async () => ({ ...state.cursor, error: null }),
    writeCursor: async (after, done) => { state.cursor = { after, done }; state.cursorWrites++; return null },
    sleep: async () => {},
  }
  return { deps, stored, state }
}

describe("mapEdgeToRow / parsePage", () => {
  it("maps a studio edge, prefixes addresses, converts UFix64 to USD", () => {
    const r = mapEdgeToRow({ node: {
      nft_id: 42, listing_resource_id: 7, sales_price: "5989000000", purchased: true,
      receiver_address: "abc", storefront_address: "0xdef", custom_id: "c",
      nft: { dist_id: 8768, status: "Opened" },
      created_at: { block_height: "100", block_time: "2026-09-24T03:15:29Z", transaction_hash: "h" },
    } })
    expect(r).toMatchObject({
      tx_hash: "h", pack_nft_id: "42", listing_resource_id: "7", sale_price_usd: 59.89,
      buyer_address: "0xabc", storefront_address: "0xdef", dist_id: "8768", nft_status: "Opened", block_height: 100,
    })
  })
  it("drops an edge with no tx hash or nft id instead of writing a keyless row", () => {
    expect(mapEdgeToRow({ node: { nft_id: 1, created_at: {} } })).toBeNull()
    expect(mapEdgeToRow({ node: { created_at: { transaction_hash: "h" } } })).toBeNull()
  })
  it("dedupes a page on the primary key so one upsert cannot touch a row twice", () => {
    const edge = { node: { nft_id: 1, created_at: { transaction_hash: "h" } } }
    expect(parsePage({ edges: [edge, edge], pageInfo: { hasNextPage: false } }).rows).toHaveLength(1)
  })
  it("reads a null edges list (Pinnacle's pack type answers totalCount 0, edges null) as an empty page", () => {
    const p = parsePage({ totalCount: 0, edges: null })
    expect(p.rows).toEqual([])
    expect(p.hasNextPage).toBe(false)
  })
})

describe("shouldContinueHead", () => {
  it("stops at the first page that brought nothing new", () => {
    expect(shouldContinueHead(0, 100, true)).toBe(false)
    expect(shouldContinueHead(1, 100, true)).toBe(true)
    expect(shouldContinueHead(5, 100, false)).toBe(false)
    expect(shouldContinueHead(0, 0, true)).toBe(false)
  })
})

describe("runPackSalesWalk", () => {
  it("lands NEW head sales even while the history sweep is latched done (the 7.5 h lag)", async () => {
    const history = Array.from({ length: 20 }, (_, i) => sale(i))
    const api = fakeApi(history)
    // Stored: everything but the 4 newest; the sweep has finished and latched.
    const s = fakeStore(history.slice(4), { after: "20", done: true })
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: api.fetchPage }, { headPages: 5, totalPages: 10, reset: false })
    expect(r.ok).toBe(true)
    expect(r.partial).toBe(false)
    expect(r.head_new).toBe(4)
    expect(r.rows_written).toBe(4)
    expect(s.stored.size).toBe(20)
    expect(r.sweep_skipped_done).toBe(true)
    // Page 1 (3 new), page 2 (1 new + 2 known), page 3 (all known) → stop.
    expect(r.head_pages).toBe(3)
  })

  it("counts rows_written as rows that did not exist, not rows offered to the upsert", async () => {
    const history = Array.from({ length: 6 }, (_, i) => sale(i))
    const s = fakeStore(history, { after: null, done: true })
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: fakeApi(history).fetchPage }, { headPages: 5, totalPages: 10, reset: false })
    expect(r.rows_found).toBe(3)
    expect(r.rows_written).toBe(0)
    expect(r.head_pages).toBe(1)
  })

  it("spends only the REMAINING budget on the sweep and advances its cursor", async () => {
    const history = Array.from({ length: 30 }, (_, i) => sale(i))
    const s = fakeStore(history.slice(0, 3), { after: "3", done: false })
    const api = fakeApi(history)
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: api.fetchPage }, { headPages: 5, totalPages: 4, reset: false })
    expect(r.head_pages).toBe(1)
    expect(r.sweep_pages).toBe(3)
    expect(s.state.cursor).toEqual({ after: "12", done: false })
    expect(r.cursor_before).toBe("3")
    expect(r.cursor_after).toBe("12")
  })

  it("latches done only on a clean end of history", async () => {
    const history = Array.from({ length: 6 }, (_, i) => sale(i))
    const s = fakeStore([], { after: "3", done: false })
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: fakeApi(history).fetchPage }, { headPages: 1, totalPages: 5, reset: false })
    expect(r.sweep_has_next).toBe(false)
    expect(s.state.cursor.done).toBe(true)
  })

  it("a failed upsert fails the RUN and does not report the page as written", async () => {
    const history = Array.from({ length: 6 }, (_, i) => sale(i))
    const s = fakeStore([], { after: null, done: true })
    const r = await runPackSalesWalk(
      { ...s.deps, upsert: async () => "permission denied", fetchPage: fakeApi(history).fetchPage },
      { headPages: 5, totalPages: 10, reset: false },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/upsert: permission denied/)
    expect(r.rows_written).toBe(0)
    expect(r.partial).toBe(true)
  })

  it("a failed cursor write fails the run and reports the cursor where it WAS", async () => {
    const history = Array.from({ length: 30 }, (_, i) => sale(i))
    const s = fakeStore(history.slice(0, 3), { after: "3", done: false })
    const r = await runPackSalesWalk(
      { ...s.deps, writeCursor: async () => "timeout", fetchPage: fakeApi(history).fetchPage },
      { headPages: 5, totalPages: 4, reset: false },
    )
    expect(r.ok).toBe(false)
    expect(r.cursor_after).toBe("3")
  })

  it("an API error on the head is a failed run, not an empty success", async () => {
    const s = fakeStore([], { after: null, done: true })
    const r = await runPackSalesWalk(
      { ...s.deps, fetchPage: async () => ({ ok: false, error: "HTTP 503" }) },
      { headPages: 5, totalPages: 10, reset: false },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/HTTP 503/)
  })

  // #135: a latched lane could never recover a gap larger than one head budget.
  it("a gap larger than the head budget is REPORTED and the latched sweep is unlatched, then healed next run", async () => {
    const history = Array.from({ length: 30 }, (_, i) => sale(i))
    // Stored: only the oldest 12. The 18 newest arrived during an outage; head budget = 2 pages × 3 = 6.
    const s = fakeStore(history.slice(18), { after: "30", done: true })
    const api = fakeApi(history)
    const r1 = await runPackSalesWalk({ ...s.deps, fetchPage: api.fetchPage }, { headPages: 2, totalPages: 2, reset: false })
    expect(r1.ok).toBe(true)
    expect(r1.head_new).toBe(6)
    expect(r1.head_budget_exhausted).toBe(true)
    expect(r1.sweep_unlatched).toBe(true)
    expect(s.state.cursor).toEqual({ after: null, done: false })
    expect(r1.cursor_after).toBeNull()
    expect(s.stored.size).toBe(18) // 12 missing rows sit behind the head

    // Without the unlatch every later run stops at a known first page and the 12 are never stored.
    for (let i = 0; i < 3 && s.stored.size < 30; i++) {
      await runPackSalesWalk({ ...s.deps, fetchPage: api.fetchPage }, { headPages: 2, totalPages: 5, reset: false })
    }
    expect(s.stored.size).toBe(30)
  })

  it("does not claim an exhausted head when the head reached a stored row on its last page", async () => {
    const history = Array.from({ length: 12 }, (_, i) => sale(i))
    const s = fakeStore(history.slice(5), { after: "12", done: true }) // page 2 = 2 new + 1 known
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: fakeApi(history).fetchPage }, { headPages: 2, totalPages: 2, reset: false })
    expect(r.head_new).toBe(5)
    expect(r.head_budget_exhausted).toBe(false)
    expect(r.sweep_unlatched).toBe(false)
    expect(s.state.cursor).toEqual({ after: "12", done: true })
    expect(s.state.cursorWrites).toBe(0)
  })

  it("mid-sweep, an exhausted head is reported but the sweep cursor is NOT reset (its progress is kept)", async () => {
    const history = Array.from({ length: 30 }, (_, i) => sale(i))
    const s = fakeStore([], { after: "21", done: false })
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: fakeApi(history).fetchPage }, { headPages: 1, totalPages: 2, reset: false })
    expect(r.head_budget_exhausted).toBe(true)
    expect(r.sweep_unlatched).toBe(false)
    expect(s.state.cursor).toEqual({ after: "24", done: false })
  })

  it("a failed unlatch write fails the run and reports the cursor still latched", async () => {
    const history = Array.from({ length: 30 }, (_, i) => sale(i))
    const s = fakeStore(history.slice(18), { after: "30", done: true })
    const r = await runPackSalesWalk(
      { ...s.deps, writeCursor: async () => "timeout", fetchPage: fakeApi(history).fetchPage },
      { headPages: 2, totalPages: 2, reset: false },
    )
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cursor unlatch: timeout/)
    expect(r.sweep_unlatched).toBe(false)
    expect(r.cursor_after).toBe("30")
  })

  it("reset=1 restarts the sweep from the head even when latched", async () => {
    const history = Array.from({ length: 9 }, (_, i) => sale(i))
    const s = fakeStore(history, { after: "9", done: true })
    const api = fakeApi(history)
    const r = await runPackSalesWalk({ ...s.deps, fetchPage: api.fetchPage }, { headPages: 1, totalPages: 3, reset: true })
    expect(r.sweep_skipped_done).toBe(false)
    expect(r.cursor_before).toBeNull()
    expect(api.calls).toEqual([null, null, "3"])
  })
})

describe("makeStudioFetch", () => {
  afterEach(() => vi.unstubAllGlobals())

  // #135: without a unique tiebreak in sortBy, a page boundary inside a bulk tx skipped rows (72 of 115 on Golazos).
  it("asks for block_time DESC with listing_resource_id DESC as the tiebreak the cursor resumes on", async () => {
    const bodies: any[] = []
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ data: { searchPackMarketplaceHistory: { totalCount: 0, pageInfo: { endCursor: null, hasNextPage: false }, edges: [] } } }), { status: 200 })
    }))
    const r = await makeStudioFetch("A.87ca73a41bb50ad5.PackNFT.NFT", {})("c1")
    expect(r.ok).toBe(true)
    const i = bodies[0].variables.i
    expect(i.after).toBe("c1")
    expect(i.sortBy.created_at.block_time).toEqual({ direction: "DESC", priority: 1 })
    expect(i.sortBy.listing_resource_id).toEqual({ direction: "DESC", priority: 2 })
  })
})
