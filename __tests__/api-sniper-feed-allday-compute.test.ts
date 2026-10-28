import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Drives the REAL computeAllDaySniperFeed via GET /api/sniper-feed?collection=nfl-all-day.
// The existing sniper-feed tests drive the TopShot compute with an empty pool (so
// the AllDay path — ~320 lines — stayed near-uncovered). Here we run it for real by
// pass-through-mocking getOrSetCache (no cache), stubbing the AllDay marketplace GQL
// fetch, and backing supabaseAdmin. Covers:
//   - the LIVE-pool path: GQL edge → buildDeal (tier strip, fmv join, discount),
//     the #1-serial + Jersey-serial specials, and the maxPrice/rarity/team/minDiscount
//     filters + price-asc sort + lowest-ask marking
//   - the RPC-FALLBACK path: empty GQL pool → get_allday_sniper_deals → deal mapping
//   - the fallback RPC error → empty result

vi.mock("@/lib/cache", () => ({ getOrSetCache: async (_k: string, _t: number, fn: any) => fn(), deleteCache: () => {} }))

const st = vi.hoisted(() => ({
  fmv: { data: [] as any[], error: null as any },
  editions: { data: [] as any[], error: null as any },
}))
const rpc = vi.hoisted(() =>
  // Explicit `Promise<any>`: without it the empty default narrows data to
  // `never[]`, so mockImplementation returning real rows fails to typecheck.
  vi.fn(async (_name: string, _params?: any): Promise<any> => ({ data: [], error: null })),
)
// ⚠ THE READ ORDER CHANGED 2026-09-02 AND THIS MOCK ENCODES IT. The FMV map used
// to page `fmv_current` filtered by `collection_id`; that filter cannot push down
// (the view is DISTINCT ON (edition_id), so collection_id is "any other column"),
// and one page measured 263,392 buffers / 19.5 s — six of those against a 45 s
// lambda budget, which is what production's paired
// "AD fmv_current statement timeout" + "Task timed out after 45 seconds" was.
//
// The route now reads AD `editions` FIRST — keyset-paged on `id`, an indexed
// column on a plain table — and then asks for FMV BY EDITION ID.
//
// 2026-09-02 (second pass): that id-keyed read moved off `fmv_current` and onto
// `get_editions_latest_fmv()`. Reaching the index is not the same as being cheap —
// the view has no per-group LIMIT, so even an index-cond scan reads every snapshot
// row per edition and lets `Unique` throw the rest away. Warm, same session, the
// whole 6,190-edition AD id list: 424,475 buffers / 631 ms for the view versus
// 24,760 / 51 ms for the helper's per-id LATERAL LIMIT 1.
//
// So the mock is: KEYSET-aware for `editions` (it slices st.editions.data and
// records each cursor in st2.editionCursors) and ID-aware for the FMV RPC (it
// returns only the rows whose edition_id was actually asked for, recording each
// chunk in st2.fmvChunks). A mock that ignored the id list would let a route that
// never filters pass.
const st2 = vi.hoisted(() => ({
  editionCursors: [] as Array<string | null>,
  fmvChunks: [] as string[][],
  /** Make the editions read IGNORE the cursor, i.e. hand back the same full page
   *  forever — the pathological case the loop's no-progress guard exists for. */
  ignoreCursor: false,
  /** editions.jersey_number rows for the special-serial read (pass 8): answered only for an `.in(external_id, …)` read. */
  jerseys: [] as Array<{ external_id: string; jersey_number: number | null }>,
  jerseyError: null as null | { message: string },
  /** sales (nft_id, serial_number) rows for the serial-from-sales read (pass 8b). */
  sales: [] as Array<{ nft_id: string; serial_number: number | null }>,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let cursor: string | null = null
      let inList: string[] | null = null
      let limit: number | null = null
      let selected = ""
      const b: any = {
        select: (cols?: string) => { selected = String(cols ?? ""); return b }, eq: () => b, order: () => b,
        in: (_col: string, list: string[]) => {
          inList = list
          return b
        },
        gt: (col: string, v: string) => {
          if (table === "editions" && col === "id") cursor = v
          return b
        },
        limit: (n: number) => { limit = n; return b },
        range: () => b,
        then: (resolve: any) => {
          if (table === "fmv_current") {
            if (st.fmv.error) return resolve({ data: null, error: st.fmv.error })
            const rows = st.fmv.data as Array<{ edition_id: string }>
            const want = inList
            return resolve({
              data: want ? rows.filter((r) => want.includes(r.edition_id)) : rows,
              error: null,
            })
          }
          if (table === "sales" && selected.includes("serial_number")) {
            const want = (inList ?? []) as string[]
            return resolve({ data: st2.sales.filter((r) => want.includes(r.nft_id)), error: null })
          }
          if (table === "editions" && selected.includes("jersey_number")) {
            if (st2.jerseyError) return resolve({ data: null, error: st2.jerseyError })
            const want = (inList ?? []) as string[]
            return resolve({ data: st2.jerseys.filter((j) => want.includes(j.external_id)), error: null })
          }
          if (table === "editions") {
            if (st.editions.error) return resolve({ data: null, error: st.editions.error })
            const all = st.editions.data as Array<{ id: string }>
            st2.editionCursors.push(cursor)
            const after = cursor && !st2.ignoreCursor ? all.filter((e) => e.id > (cursor as string)) : all
            return resolve({ data: limit ? after.slice(0, limit) : after, error: null })
          }
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

/** Default RPC behaviour. ID-aware for the FMV helper: it records the chunk it was
 *  asked for and returns ONLY those rows, so a route that stopped passing ids —
 *  or started asking for a whole collection again — cannot pass. Everything else
 *  answers empty, which is what the GQL-fallback tests then override. */
async function defaultRpc(name: string, params?: any) {
  if (name === "get_editions_latest_fmv") {
    const want: string[] = params?.p_edition_ids ?? []
    st2.fmvChunks.push(want)
    if (st.fmv.error) return { data: null, error: st.fmv.error }
    const rows = st.fmv.data as Array<{ edition_id: string }>
    return { data: rows.filter((r) => want.includes(r.edition_id)), error: null }
  }
  return { data: [], error: null }
}

// AllDay GQL fetch fixture.
let gqlEdges: any[] = []
let gqlHasNext = false
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    text: async () => "",
    json: async () => ({
      data: { searchMarketplaceEditions: { edges: gqlEdges, pageInfo: { endCursor: null, hasNextPage: gqlHasNext } } },
    }),
  })))
}

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const ADQS = "?collection=nfl-all-day&minDiscount=0&maxPrice=100000&rarity=all&team=all"

beforeEach(() => {
  // The All Day GQL leg is opt-in since 2026-09-28; this file drives its shaping.
  process.env.ALLDAY_MARKETPLACE_GQL = "1"
  st2.editionCursors = []
  st2.fmvChunks = []
  st2.ignoreCursor = false
  st.fmv = { data: [], error: null }
  st.editions = { data: [], error: null }
  rpc.mockReset()
  rpc.mockImplementation(defaultRpc)
  gqlEdges = []
  gqlHasNext = false
  installFetch()
})
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ALLDAY_MARKETPLACE_GQL })

const node = (over: any = {}) => ({
  node: {
    editionFlowID: 555,
    lowestPrice: "60",
    edition: {
      tier: "MOMENT_TIER_RARE",
      maxMintSize: 100,
      currentMintSize: 100,
      badges: [{ slug: "rookie", title: "Rookie" }],
      play: { metadata: { playerFullName: "Joe Player", teamName: "Bills" } },
      set: { name: "Base Set" },
      series: { name: "Series 1" },
      parallel: "Base",
    },
    ...over,
  },
})

describe("GET /api/sniper-feed?collection=nfl-all-day — computeAllDaySniperFeed", () => {
  it("live pool: shapes a GQL edge into a SniperDeal with fmv join + computed discount", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]

    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(1)
    const d = body.deals[0]
    expect(d.source).toBe("allday")
    expect(d.playerName).toBe("Joe Player")
    expect(d.tier).toBe("RARE") // MOMENT_TIER_ stripped
    expect(d.askPrice).toBe(60)
    expect(d.baseFmv).toBe(100)
    expect(d.discount).toBe(40) // (100-60)/100
    expect(d.confidenceSource).toBe("fmv_snapshots")
    expect(d.hasBadge).toBe(true)
    expect(d.isLowestAsk).toBe(true)
  })

  // 2026-07-25 — was: "no FMV entry → ask-fallback confidence, 0 discount
  // (askPrice == baseFmv)". buildDeal used `fmvEntry?.fmv || askPrice`, so a
  // listing with no FMV shipped with baseFmv == askPrice and a fake 0%
  // discount. Borrowing the ask fabricates a fair value; the row is dropped now.
  it("no FMV entry → row is EXCLUDED (never borrows the ask as FMV)", async () => {
    gqlEdges = [node()] // no fmv/editions rows → fmvMap empty
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    expect(body.deals).toEqual([])
  })

  it("fmv_snapshots row with a NULL fmv_usd → row is EXCLUDED, not $0.00 and not the ask", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: null, confidence: "LOW", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    // NOTE: nothing filters this NULL out before the map — the route deliberately
    // does NOT reproduce the old read's server-side `.gt("fmv_usd", 0)`, because
    // that filter would make this test pass on the filter instead of on
    // buildDeal's OWN guard, the second layer. The old
    // `Number(null) || 0` + `|| askPrice` combination produced a row labelled
    // confidenceSource "fmv_snapshots" with baseFmv == askPrice (60).
    expect(body.deals.some((d: any) => d.baseFmv === 0 || d.baseFmv === 60)).toBe(false)
  })

  it("fmv_snapshots row with fmv_usd 0 → row is EXCLUDED (never a $0.00 fair value)", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 0, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
  })

  it("#1-serial and Jersey-serial specials add extra deals", async () => {
    // Needs a real FMV: since 2026-07-25 a listing with no FMV is excluded
    // outright rather than shipped with baseFmv borrowed from the ask.
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node({
      numberOneSerial: { flowID: 5551, momentNFTListing: { priceV2: { value: "10" } } },
      jerseySerial: { flowID: 5552, momentNFTListing: { priceV2: { value: "20" } } },
    })]
    const body = await (await GET(get(ADQS))).json()
    // floor + #1 + jersey = 3
    expect(body.count).toBe(3)
    const signals = body.deals.map((d: any) => d.serialSignal).sort()
    expect(signals).toContain("#1")
    expect(signals).toContain("Jersey Serial")
    // price-asc sort: cheapest (#1 @10) first
    expect(body.deals[0].askPrice).toBe(10)
  })

  // ── PostgREST 1000-row cap (2026-07-25) ──────────────────────────────────
  // The FMV map used to read raw fmv_snapshots `.eq(collection).order(DESC)`
  // with NO bound, on the belief that AD had "~341 rows". Live it is 306,895
  // snapshot rows over 6,190 editions, so PostgREST's cap meant the map only
  // ever held a few hundred editions — and once a missing FMV EXCLUDES a row,
  // a truncated map silently drops most of the board. Now it reads fmv_current
  // (<=1 row/edition) and pages with .range().
  it("pages editions past the 1000-row cap so a high-offset edition still prices", async () => {
    // 1,500 editions: the target sits at index 1,200, i.e. only reachable on the
    // SECOND page. Under a single unbounded read it would be invisible.
    //
    // ⚠ The cap now bites on the EDITIONS read, not the FMV read — that is the
    // whole point of the 2026-09-02 inversion. Ids are zero-padded so the keyset
    // cursor (`id > last`) orders the way the route assumes.
    const eds = Array.from({ length: 1500 }, (_, i) => ({
      id: `E${String(i).padStart(5, "0")}`,
      external_id: `X${i}`,
    }))
    eds[1200] = { id: "E01200", external_id: "555" }
    st.editions = { data: eds, error: null }
    st.fmv = {
      data: [
        ...eds.slice(0, 100).map((e) => ({ edition_id: e.id, fmv_usd: 100, confidence: "HIGH" })),
        { edition_id: "E01200", fmv_usd: 250, confidence: "HIGH" },
      ],
      error: null,
    }
    gqlEdges = [node()]

    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(1)
    expect(body.deals[0].baseFmv).toBe(250) // priced off an edition past the cap
    expect(body.deals[0].discount).toBe(76) // (250-60)/250
    // First read has no cursor; the second resumes after page 1's last id.
    expect(st2.editionCursors.length).toBeGreaterThanOrEqual(2)
    expect(st2.editionCursors[0]).toBeNull()
    expect(st2.editionCursors[1]).toBe("E00999")
  })

  it("terminates when the editions cursor cannot advance, instead of walking to the page ceiling", async () => {
    // An upstream that keeps returning the same full page. Without the
    // no-progress guard the loop runs to its ceiling (200 pages), turning a
    // 1,000-row read into 200,000 rows of duplicates on a route that already
    // has a 45-second budget.
    st2.ignoreCursor = true
    st.editions = {
      data: Array.from({ length: 1000 }, (_, i) => ({ id: `E${String(i).padStart(5, "0")}`, external_id: `X${i}` })),
      error: null,
    }
    st.fmv = { data: [], error: null }
    gqlEdges = [node()]

    await GET(get(ADQS))
    // First read (no cursor) + the repeat that proves no progress. Never 200.
    expect(st2.editionCursors.length).toBeLessThanOrEqual(2)
  })

  it("asks for FMV by EDITION ID, never for the whole collection", async () => {
    // 🚨 The defect was the read's SHAPE, not its size. `fmv_current` is
    // DISTINCT ON (edition_id): a qual on that key pushes into the index, a qual
    // on collection_id does not and materialises 274,519 snapshot rows per page.
    // Pinning the id list means a refactor back to a collection-wide scan reds
    // here rather than in production's 45-second timeout.
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 250, confidence: "HIGH" }], error: null }
    gqlEdges = [node()]

    await GET(get(ADQS))
    expect(st2.fmvChunks.length).toBeGreaterThanOrEqual(1)
    expect(st2.fmvChunks[0]).toEqual(["E1"])
  })

  it("stops chunking and degrades (no throw) when an fmv read errors", async () => {
    st.fmv = { data: [], error: { message: "fmv helper down" } }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const res = await GET(get(ADQS))
    expect(res.status).toBe(200) // degrades to an unpriced (therefore empty) feed
    const body = await res.json()
    expect(body.count).toBe(0)
    expect(st2.fmvChunks.length).toBe(1) // broke out after the first failed chunk
    // ...and says so, rather than letting an empty board read as a quiet market.
    expect(body.sourcesFailed).toContain("allday-fmv")
  })

  it("a failed EDITIONS read is named too — no edition row means no FMV lookup", async () => {
    st.editions = { data: [], error: { message: "editions down" } }
    st.fmv = { data: [], error: null }
    gqlEdges = [node()]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    expect(body.sourcesFailed).toContain("allday-fmv")
  })

  it("a listing with no/zero price is dropped (buildDeal returns null)", async () => {
    gqlEdges = [node({ lowestPrice: "0" })]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
  })

  it("rarity filter drops non-matching tiers", async () => {
    gqlEdges = [node()] // RARE
    const body = await (await GET(get("?collection=nfl-all-day&rarity=legendary&maxPrice=100000"))).json()
    expect(body.count).toBe(0)
  })

  it("maxPrice filter drops listings above the cap", async () => {
    gqlEdges = [node({ lowestPrice: "500" })]
    const body = await (await GET(get("?collection=nfl-all-day&maxPrice=100"))).json()
    expect(body.count).toBe(0)
  })

  it("RPC-fallback path: empty GQL pool → get_allday_sniper_deals → mapped deals", async () => {
    gqlEdges = [] // empty pool triggers the RPC fallback
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return {
          data: [
            { flow_id: "f1", moment_id: "m1", tier: "MOMENT_TIER_LEGENDARY", confidence: "HIGH", player_name: "A", team_name: "T", ask_price: 30, fmv_usd: 50, discount_pct: 40, buy_url: "u", listing_resource_id: "lr" },
            { flow_id: "f2", moment_id: "m2", tier: "COMMON", confidence: "ASK_ONLY", player_name: "B", ask_price: 10, fmv_usd: 0, discount_pct: 0 },
            { flow_id: "f3", moment_id: "m3", tier: "COMMON", confidence: "ASK_ONLY", player_name: "C", ask_price: 12, fmv_usd: null, discount_pct: 0 },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })

    const body = await (await GET(get(ADQS))).json()
    // 2026-07-25: rows B (fmv_usd 0) and C (fmv_usd NULL) are dropped — the old
    // mapping emitted them with baseFmv/adjustedFmv 0, i.e. a literal $0.00
    // fair value on the board.
    expect(body.count).toBe(1)
    expect(body.flowtyCount).toBe(1)
    const legendary = body.deals.find((d: any) => d.playerName === "A")
    expect(legendary.tier).toBe("LEGENDARY") // MOMENT_TIER_ stripped
    expect(legendary.source).toBe("allday")
    expect(legendary.confidenceSource).toBe("fmv_snapshots")
    expect(body.deals.some((d: any) => d.playerName === "B" || d.playerName === "C")).toBe(false)
    expect(body.deals.every((d: any) => d.baseFmv > 0)).toBe(true)
  })

  it("RPC-fallback flags an ASK_ONLY / STALE FMV as low-confidence (2026-09-25)", async () => {
    // This leg set no flag at all, so the live All Day board (GQL 403s on Vercel
    // egress) was topped by Dalton Kincaid's Dynamic LEGENDARY: $30 vs a STALE
    // $570.86 built on 2024 sales — "94.7% off", rendered and quoted as a deal.
    gqlEdges = []
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return {
          data: [
            { flow_id: "k", moment_id: "mk", tier: "LEGENDARY", confidence: "STALE", player_name: "Dalton Kincaid", ask_price: 30, fmv_usd: 570.86, discount_pct: 94.7 },
            { flow_id: "w", moment_id: "mw", tier: "RARE", confidence: "ASK_ONLY", player_name: "Donovan Wilson", ask_price: 5, fmv_usd: 81, discount_pct: 93.8 },
            { flow_id: "h", moment_id: "mh", tier: "RARE", confidence: "HIGH", player_name: "Alvin Kamara", ask_price: 2, fmv_usd: 3.67, discount_pct: 45.5 },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("Dalton Kincaid").lowConfidenceFmv).toBe(true)
    expect(by("Donovan Wilson").lowConfidenceFmv).toBe(true)
    expect(by("Alvin Kamara").lowConfidenceFmv).toBe(false)
  })

  // 2026-10-26 (All Day parity): this path built every deal with hasBadge=false, so BADGES ONLY was dead on All Day.
  it("RPC-fallback decorates deals with their edition's badges by listing id", async () => {
    gqlEdges = []
    rpc.mockImplementation(async (name: string, params?: any) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [
          { flow_id: "r", moment_id: "mr", tier: "COMMON", confidence: "HIGH", player_name: "RJ Harvey", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "111" },
          { flow_id: "q", moment_id: "mq", tier: "COMMON", confidence: "HIGH", player_name: "Quinn Meinerz", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "222" },
        ], error: null }
      }
      if (name === "get_allday_listing_badges") {
        expect(params.p_listing_ids.sort()).toEqual([111, 222])
        return { data: [{ listing_resource_id: 111, edition_key: "4273", badges: ["Rookie Mint", "Rookie Year"] }, { listing_resource_id: 222, edition_key: "3674", badges: [] }], error: null }
      }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("RJ Harvey")).toMatchObject({ hasBadge: true, badgeSlugs: ["Rookie Mint", "Rookie Year"] })
    expect(by("Quinn Meinerz")).toMatchObject({ hasBadge: false, badgeSlugs: [] })
    // pass 3: the edition key rides along, so the Own / Lock cell can match wallet edition counts
    expect(by("RJ Harvey").editionKey).toBe("4273")
    expect(by("Quinn Meinerz").editionKey).toBe("3674")
  })

  it("a failed badge read leaves deals undecorated and does NOT mark the board degraded (enrichment, not a source)", async () => {
    gqlEdges = []
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [{ flow_id: "r", moment_id: "mr", tier: "COMMON", confidence: "HIGH", player_name: "RJ Harvey", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "111" }], error: null }
      }
      if (name === "get_allday_listing_badges") return { data: null, error: { message: "timeout" } }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    expect(body.deals).toHaveLength(1)
    expect(body.deals[0].hasBadge).toBe(false)
    expect(body.deals[0].editionKey).toBe("") // unmapped: the client renders ownership as unknown
    expect(body.sourcesFailed ?? []).not.toContain("allday-badges")
  })

  // 2026-10-27 (pass 8): All Day rows are LISTINGS with real serials, so #1 / jersey / last mint are flagged —
  // display only (serialMult stays 1, the discount is untouched); a failed jersey read only loses jersey matches.
  it("RPC-fallback flags #1, jersey and last-mint serials from the listing's serial", async () => {
    gqlEdges = []
    st2.jerseys = [{ external_id: "4273", jersey_number: 2 }, { external_id: "3674", jersey_number: 77 }]
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [
          { flow_id: "a", moment_id: "ma", tier: "COMMON", confidence: "HIGH", player_name: "One", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "1", serial_number: 1, circulation_count: 500 },
          { flow_id: "b", moment_id: "mb", tier: "COMMON", confidence: "HIGH", player_name: "Jersey", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "2", serial_number: 2, circulation_count: 500 },
          { flow_id: "c", moment_id: "mc", tier: "COMMON", confidence: "HIGH", player_name: "Last", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "3", serial_number: 99, circulation_count: 99 },
          { flow_id: "d", moment_id: "md", tier: "COMMON", confidence: "HIGH", player_name: "Plain", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "4", serial_number: 40, circulation_count: 500 },
          { flow_id: "e", moment_id: "me", tier: "COMMON", confidence: "HIGH", player_name: "NoCirc", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "5", serial_number: 0, circulation_count: 0 },
        ], error: null }
      }
      if (name === "get_allday_listing_badges") {
        return { data: [
          { listing_resource_id: 1, edition_key: "4273", badges: [] },
          { listing_resource_id: 2, edition_key: "4273", badges: [] },
          { listing_resource_id: 3, edition_key: "3674", badges: [] },
          { listing_resource_id: 4, edition_key: "3674", badges: [] },
        ], error: null }
      }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("One")).toMatchObject({ isSpecialSerial: true, serialSignal: "#1", isJersey: false })
    expect(by("Jersey")).toMatchObject({ isSpecialSerial: true, serialSignal: "Jersey #2", isJersey: true })
    expect(by("Last")).toMatchObject({ isSpecialSerial: true, serialSignal: "Last #99", isJersey: false })
    expect(by("Plain")).toMatchObject({ isSpecialSerial: false, serialSignal: null })
    expect(by("NoCirc")).toMatchObject({ isSpecialSerial: false })
    // display only — never re-prices the deal
    for (const d of body.deals) { expect(d.serialMult).toBe(1); expect(d.discount).toBe(50) }
    st2.jerseys = []
  })

  it("a deal whose serial the wallet cache lacks takes it from a past sale of the same NFT — and is then flagged", async () => {
    gqlEdges = []
    st2.sales = [{ nft_id: "f1", serial_number: 1 }, { nft_id: "f1", serial_number: 1 }]
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [
          { flow_id: "f1", moment_id: "m1", tier: "COMMON", confidence: "HIGH", player_name: "FromSales", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "1", serial_number: null, circulation_count: 500 },
          { flow_id: "f2", moment_id: "m2", tier: "COMMON", confidence: "HIGH", player_name: "Unknown", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "2", serial_number: null, circulation_count: 500 },
        ], error: null }
      }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("FromSales")).toMatchObject({ serial: 1, isSpecialSerial: true, serialSignal: "#1" })
    expect(by("Unknown")).toMatchObject({ serial: 0, isSpecialSerial: false })
    st2.sales = []
  })

  // 10-27 review: 21 All Day nft_ids carry two different serials in sales (nft 10509376: 523 and 14 on a /39
  // edition) and the rows arrive unordered, so the winner was arbitrary — and "#523 / 39" could render.
  it("sales that disagree on an NFT's serial, or name a serial above circulation, leave it unknown", async () => {
    gqlEdges = []
    st2.sales = [
      { nft_id: "c1", serial_number: 523 }, { nft_id: "c1", serial_number: 14 },
      { nft_id: "c2", serial_number: 1413 },
      { nft_id: "c3", serial_number: 7 }, { nft_id: "c3", serial_number: 7 },
    ]
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [
          { flow_id: "c1", moment_id: "m1", tier: "COMMON", confidence: "HIGH", player_name: "Conflict", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "1", serial_number: null, circulation_count: 39 },
          { flow_id: "c2", moment_id: "m2", tier: "COMMON", confidence: "HIGH", player_name: "TooBig", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "2", serial_number: null, circulation_count: 299 },
          { flow_id: "c3", moment_id: "m3", tier: "COMMON", confidence: "HIGH", player_name: "Agree", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "3", serial_number: null, circulation_count: 299 },
        ], error: null }
      }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("Conflict")).toMatchObject({ serial: 0, isSpecialSerial: false })
    expect(by("TooBig")).toMatchObject({ serial: 0, isSpecialSerial: false })
    expect(by("Agree")).toMatchObject({ serial: 7 })
    st2.sales = []
  })

  it("a failed jersey read keeps #1 / last-mint flags and does not degrade the board", async () => {
    gqlEdges = []
    st2.jerseyError = { message: "timeout" }
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return { data: [
          { flow_id: "a", moment_id: "ma", tier: "COMMON", confidence: "HIGH", player_name: "One", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "1", serial_number: 1, circulation_count: 500 },
          { flow_id: "b", moment_id: "mb", tier: "COMMON", confidence: "HIGH", player_name: "Jersey", ask_price: 1, fmv_usd: 2, discount_pct: 50, listing_resource_id: "2", serial_number: 2, circulation_count: 500 },
        ], error: null }
      }
      if (name === "get_allday_listing_badges") return { data: [{ listing_resource_id: 1, edition_key: "4273", badges: [] }, { listing_resource_id: 2, edition_key: "4273", badges: [] }], error: null }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    const by = (p: string) => body.deals.find((d: any) => d.playerName === p)
    expect(by("One").serialSignal).toBe("#1")
    expect(by("Jersey").isSpecialSerial).toBe(false)
    expect(body.sourcesFailed ?? []).not.toContain("allday_edition_jerseys")
    st2.jerseyError = null
  })

  it("RPC-fallback error → empty result", async () => {
    gqlEdges = []
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") return { data: null, error: { message: "rpc down" } }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    expect(body.deals).toEqual([])
  })
})

// 2026-09-29 — an All Day team pick covers every label its franchise has carried
// (as on Top Shot): get_allday_sniper_deals takes ONE exact p_team, so the route
// asks once per label and merges, re-sorted and deduped by listing.
describe("All Day team pick covers the franchise", () => {
  const row = (flow_id: string, team_name: string, ask_price: number) => ({
    flow_id, moment_id: `m-${flow_id}`, tier: "COMMON", confidence: "HIGH", player_name: "P",
    team_name, ask_price, fmv_usd: 100, discount_pct: 10,
  })
  function franchiseRpc(over: Record<string, (p: any) => any> = {}) {
    return async (name: string, params?: any) => {
      if (over[name]) return over[name](params)
      if (name === "team_franchise_slugs") return { data: ["las-vegas-raiders", "oakland-raiders", "los-angeles-raiders"], error: null }
      if (name === "league_team_abbr") return { data: [{ team_name: "Oakland Raiders" }, { team_name: "Los Angeles Raiders" }, { team_name: "Las Vegas Raiders" }], error: null }
      if (name === "get_teams_for_league") return { data: [{ team_name: "Las Vegas Raiders", has_moments: true }, { team_name: "Buffalo Bills", has_moments: true }], error: null }
      if (name === "get_allday_sniper_deals") {
        const byTeam: Record<string, any[]> = {
          "Las Vegas Raiders": [row("lv1", "Las Vegas Raiders", 30), row("lv2", "Las Vegas Raiders", 5)],
          "Oakland Raiders": [row("oak1", "Oakland Raiders", 12), row("lv2", "Las Vegas Raiders", 5)],
          "Los Angeles Raiders": [row("la1", "Los Angeles Raiders", 1)],
        }
        return { data: byTeam[params?.p_team] ?? [], error: null }
      }
      return defaultRpc(name, params)
    }
  }
  beforeEach(() => { delete process.env.ALLDAY_MARKETPLACE_GQL })
  const teamQs = `?collection=nfl-all-day&sortBy=price_asc&team=${encodeURIComponent("Las Vegas Raiders")}`

  it("asks once per franchise label, merges deduped, re-sorts, and echoes the pick", async () => {
    rpc.mockImplementation(franchiseRpc())
    const body = await (await GET(get(teamQs))).json()
    const asked = rpc.mock.calls.filter(([n]) => n === "get_allday_sniper_deals").map(([, p]) => p.p_team).sort()
    expect(asked).toEqual(["Las Vegas Raiders", "Los Angeles Raiders", "Oakland Raiders"])
    expect(body.deals.map((d: any) => d.flowId)).toEqual(["la1", "lv2", "oak1", "lv1"]) // price_asc, lv2 once
    expect(body.degraded).toBe(false)
    expect(body.teamApplied).toBe("Las Vegas Raiders")
    expect(body.teamOptions).toEqual(["Buffalo Bills", "Las Vegas Raiders"])
  })

  it("one label's call failing still renders the others and reports the board degraded", async () => {
    rpc.mockImplementation(franchiseRpc({
      get_allday_sniper_deals: (p) => p.p_team === "Oakland Raiders"
        ? { data: null, error: { message: "timeout" } }
        : { data: p.p_team === "Las Vegas Raiders" ? [row("lv1", "Las Vegas Raiders", 30)] : [], error: null },
    }))
    const body = await (await GET(get(teamQs))).json()
    expect(body.deals.map((d: any) => d.flowId)).toEqual(["lv1"])
    expect(body.sourcesFailed).toContain("allday-deals-rpc")
    expect(body.degraded).toBe(true)
  })

  // 2026-09-29 (migration 20260930013059): the player is searched IN the RPC.
  // Filtering its top 200 afterwards found 1 Mahomes listing of 88.
  it("a player search is pushed into the RPC as p_player (and absent on the default board)", async () => {
    rpc.mockImplementation(franchiseRpc())
    await GET(get("?collection=nfl-all-day&sortBy=price_asc&player=Mahomes"))
    const withPlayer = rpc.mock.calls.filter(([n]) => n === "get_allday_sniper_deals").map(([, p]) => p)
    expect(withPlayer.length).toBeGreaterThan(0)
    for (const p of withPlayer) expect(p.p_player).toBe("Mahomes")

    rpc.mockClear()
    await GET(get("?collection=nfl-all-day&sortBy=price_asc"))
    for (const [n, p] of rpc.mock.calls) if (n === "get_allday_sniper_deals") expect(p.p_player).toBeUndefined()
  })

  it("a failed franchise lookup falls back to the exact label and reports the board as narrowed", async () => {
    rpc.mockImplementation(franchiseRpc({ team_franchise_slugs: () => ({ data: null, error: { message: "boom" } }) }))
    const body = await (await GET(get(teamQs))).json()
    const asked = rpc.mock.calls.filter(([n]) => n === "get_allday_sniper_deals").map(([, p]) => p.p_team)
    expect(asked).toEqual(["Las Vegas Raiders"])
    expect(body.sourcesFailed).toContain("team-franchise")
    expect(body.degraded).toBe(true)
  })
})
