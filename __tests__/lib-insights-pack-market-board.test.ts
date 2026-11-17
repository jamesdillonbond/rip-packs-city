import { describe, it, expect, vi, afterEach } from "vitest"
import {
  bucketPackMarketRows,
  fetchPackMarketBuckets,
  PACK_MARKET_BOARDS,
  DISCOUNT_MAX_RATIO,
  PREMIUM_MIN_RATIO,
  RANK_LIMIT,
  MIN_SALES,
  num,
  type PackMarketRow,
} from "@/lib/insights/pack-market-board"

// The sealed-pack secondary-market ranking, shared by /insights/allday-pack-market
// and /insights/topshot-pack-market.
//
// ⚠ THIS LOGIC WAS UNREACHABLE UNTIL IT WAS EXTRACTED. It lived, duplicated, in
// two `page.tsx` files — which the primary coverage gate does not measure (it
// stops at `route.{ts,tsx}`) and the component gate does not measure either. So
// the thresholds that decide which packs a collector is shown as "trading at a
// discount" had no test at all, on two PUBLIC boards.

function row(p: Partial<PackMarketRow> & { dist_id: string }): PackMarketRow {
  return {
    title: null,
    drop_size: null,
    retail_price: 10,
    opened_pct: null,
    n_sales: 10,
    n_sales_90d: null,
    last_sale_price: null,
    last_sale_at: null,
    median_price_90d: null,
    secondary_vs_retail_ratio: 1,
    ...p,
  }
}

describe("num", () => {
  it("treats an empty string as absent rather than as zero", () => {
    // ⚠ PostgREST returns numerics as STRINGS, and an empty one is a missing
    // value. `Number("")` is 0, so a bare cast would rank an unpriced pack as
    // free — the worst possible discount, straight to the top of the board.
    expect(num("")).toBeNull()
    expect(num(null)).toBeNull()
    expect(num(undefined)).toBeNull()
    expect(num("0")).toBe(0)
    expect(num("12.5")).toBe(12.5)
    expect(num("not-a-number")).toBeNull()
  })
})

describe("bucketPackMarketRows", () => {
  it("ranks discounts cheapest-first and premiums dearest-first", () => {
    const b = bucketPackMarketRows([
      row({ dist_id: "mid", secondary_vs_retail_ratio: 0.8 }),
      row({ dist_id: "cheapest", secondary_vs_retail_ratio: 0.2 }),
      row({ dist_id: "dearest", secondary_vs_retail_ratio: 4 }),
      row({ dist_id: "warm", secondary_vs_retail_ratio: 1.2 }),
    ])
    expect(b.discount.map((r) => r.dist_id)).toEqual(["cheapest", "mid"])
    expect(b.premium.map((r) => r.dist_id)).toEqual(["dearest", "warm"])
  })

  // ⚠ THE BOUNDARIES. These two constants are the entire definition of the words
  // "discount" and "premium" as this board uses them, and both comparisons are
  // STRICT — a pack sitting exactly on either line appears in neither ranking.
  // Pinned from both sides, because an off-by-one here silently re-labels packs
  // on a public board.
  it("excludes a pack sitting EXACTLY on either threshold", () => {
    const b = bucketPackMarketRows([
      row({ dist_id: "on-discount-line", secondary_vs_retail_ratio: DISCOUNT_MAX_RATIO }),
      row({ dist_id: "just-under", secondary_vs_retail_ratio: DISCOUNT_MAX_RATIO - 0.001 }),
      row({ dist_id: "on-premium-line", secondary_vs_retail_ratio: PREMIUM_MIN_RATIO }),
      row({ dist_id: "just-over", secondary_vs_retail_ratio: PREMIUM_MIN_RATIO + 0.001 }),
    ])
    expect(b.discount.map((r) => r.dist_id)).toEqual(["just-under"])
    expect(b.premium.map((r) => r.dist_id)).toEqual(["just-over"])
  })

  it("keeps an UNPRICED pack out of both rankings but still counts it", () => {
    // ⚠ A pack with no retail price has no ratio to rank BY. Ranking it anyway
    // would put an unrankable row in a ranking — and because `num("")` is null
    // rather than 0, it cannot slip in as a 0-priced pack either. It still
    // counts toward `qualifying`, which is a claim about the market's size, not
    // about price.
    const b = bucketPackMarketRows([
      row({ dist_id: "priced", secondary_vs_retail_ratio: 0.5 }),
      row({ dist_id: "no-retail", retail_price: null, secondary_vs_retail_ratio: 0.1 }),
      row({ dist_id: "zero-retail", retail_price: 0, secondary_vs_retail_ratio: 0.1 }),
      row({ dist_id: "empty-retail", retail_price: "", secondary_vs_retail_ratio: 0.1 }),
      row({ dist_id: "no-ratio", secondary_vs_retail_ratio: null }),
    ])
    expect(b.discount.map((r) => r.dist_id)).toEqual(["priced"])
    expect(b.qualifying, "every row counts toward the market's size").toBe(5)
  })

  it("ranks mostTraded over ALL rows, including the unpriced ones", () => {
    // Deliberately NOT the `priced` set: "most traded" is a claim about volume,
    // and a pack with no retail price still trades. Narrowing this to priced
    // rows would quietly drop real activity from a volume ranking.
    const b = bucketPackMarketRows([
      row({ dist_id: "busy-unpriced", retail_price: null, n_sales: 900 }),
      row({ dist_id: "quiet-priced", n_sales: 5 }),
    ])
    expect(b.mostTraded.map((r) => r.dist_id)).toEqual(["busy-unpriced", "quiet-priced"])
  })

  it("caps each ranking at RANK_LIMIT and takes the TOP of the order, not the first N", () => {
    // ⚠ The slice comes AFTER the sort. Slicing first would publish an arbitrary
    // 15 under the heading "biggest discounts" — the silently-sliced-ranking
    // class. Rows are supplied WORST-FIRST (d0 is the least discounted), so a
    // pre-sort slice keeps d0..d14 and drops the five deepest discounts — the
    // wrong SET, not merely the wrong order.
    //
    // ⚠ A first draft reversed this array, and the slice-before-sort mutation
    // SURVIVED: supplied best-first, both orderings select the same 15 rows and
    // only the order differs, which the sort then fixes. The fixture has to make
    // the two disagree about MEMBERSHIP.
    const rows = Array.from({ length: RANK_LIMIT + 5 }, (_, i) =>
      row({ dist_id: `d${i}`, secondary_vs_retail_ratio: 0.8 - i * 0.01 }),
    )
    const b = bucketPackMarketRows(rows)
    expect(b.discount).toHaveLength(RANK_LIMIT)
    expect(b.discount[0].dist_id, "the cheapest row leads").toBe(`d${RANK_LIMIT + 4}`)
    expect(b.discount.map((r) => r.dist_id)).not.toContain("d0")
  })

  it("reports the LATEST last_sale_at, ignoring rows that have none", () => {
    const b = bucketPackMarketRows([
      row({ dist_id: "a", last_sale_at: "2026-01-01T00:00:00Z" }),
      row({ dist_id: "b", last_sale_at: null }),
      row({ dist_id: "c", last_sale_at: "2026-06-01T00:00:00Z" }),
    ])
    expect(b.lastSaleAt).toBe("2026-06-01T00:00:00Z")
  })

  it("an empty board is an honest empty answer, not a failure", () => {
    const b = bucketPackMarketRows([])
    expect(b).toEqual({
      discount: [],
      premium: [],
      mostTraded: [],
      qualifying: 0,
      lastSaleAt: null,
    })
  })

  it("does not mutate the caller's array", () => {
    // `mostTraded` sorts, and Array.prototype.sort is in-place. Without the
    // .slice() the caller's row order changes underneath it — and `lastSaleAt`
    // is computed from that same array afterwards.
    const rows = [row({ dist_id: "a", n_sales: 1 }), row({ dist_id: "b", n_sales: 99 })]
    bucketPackMarketRows(rows)
    expect(rows.map((r) => r.dist_id)).toEqual(["a", "b"])
  })
})

describe("fetchPackMarketBuckets", () => {
  afterEach(() => vi.restoreAllMocks())

  function dbReturning(result: { rows?: PackMarketRow[]; error?: unknown }) {
    const calls: { view?: string; select?: string; gte?: [string, unknown] } = {}
    const builder: Record<string, unknown> = {}
    for (const m of ["select", "gte", "order", "range"]) {
      builder[m] = (...args: unknown[]) => {
        if (m === "select") calls.select = args[0] as string
        if (m === "gte") calls.gte = [args[0] as string, args[1]]
        return builder
      }
    }
    builder.then = (onF?: (v: unknown) => unknown) =>
      Promise.resolve({ data: result.rows ?? [], error: result.error ?? null }).then(onF)
    return {
      calls,
      db: {
        from: (view: string) => {
          calls.view = view
          return builder
        },
      },
    }
  }

  it("a FAILED read reports ok:false with empty rankings, never an empty board", async () => {
    // ⚠ The distinction the page renders as a degraded notice vs an honest
    // "no qualifying packs yet". Collapsing them publishes our outage as a claim
    // about the market.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = dbReturning({ error: { message: "canceling statement due to statement timeout" } })
    const b = await fetchPackMarketBuckets("allday", db)
    expect(b.ok).toBe(false)
    expect(b).toMatchObject({ discount: [], premium: [], mostTraded: [], qualifying: 0, lastSaleAt: null })
  })

  it("a SUCCESSFUL read with no rows is ok:true — an empty board is an answer", async () => {
    const { db } = dbReturning({ rows: [] })
    const b = await fetchPackMarketBuckets("allday", db)
    expect(b.ok).toBe(true)
    expect(b.qualifying).toBe(0)
  })

  it.each(Object.keys(PACK_MARKET_BOARDS) as Array<keyof typeof PACK_MARKET_BOARDS>)(
    "%s reads its own view and aliases its own ripped-share column to opened_pct",
    async (board) => {
      // ⚠ The alias is what lets ONE row type serve two views whose columns are
      // named differently. If it were dropped, `r.opened_pct` would be undefined
      // and the column would render as an em-dash on a live board — silently,
      // since a missing property is not an error.
      const { calls, db } = dbReturning({ rows: [] })
      await fetchPackMarketBuckets(board, db)
      const src = PACK_MARKET_BOARDS[board]
      expect(calls.view).toBe(src.view)
      expect(calls.select).toContain(`opened_pct:${src.openedColumn}`)
      expect(calls.gte).toEqual(["n_sales", MIN_SALES])
    },
  )

  it("the two boards do not share a view or a column — the config is the only difference", () => {
    // Guards the guard: if both entries pointed at the same view, every
    // per-board assertion above would still pass while one board rendered the
    // other's data.
    expect(PACK_MARKET_BOARDS.allday.view).not.toBe(PACK_MARKET_BOARDS.topshot.view)
    expect(PACK_MARKET_BOARDS.allday.openedColumn).not.toBe(PACK_MARKET_BOARDS.topshot.openedColumn)
  })

  it("ranks the rows it fetched", async () => {
    const { db } = dbReturning({
      rows: [
        row({ dist_id: "cheap", secondary_vs_retail_ratio: 0.3 }),
        row({ dist_id: "dear", secondary_vs_retail_ratio: 3 }),
      ],
    })
    const b = await fetchPackMarketBuckets("topshot", db)
    expect(b.ok).toBe(true)
    expect(b.discount.map((r) => r.dist_id)).toEqual(["cheap"])
    expect(b.premium.map((r) => r.dist_id)).toEqual(["dear"])
  })
})
