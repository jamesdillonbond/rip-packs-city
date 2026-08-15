import { describe, it, expect } from "vitest"

import { fetchSqueezeBoard, SQUEEZE_COLS } from "@/lib/insights/squeeze-board"
import { fetchTrophiesBoard, TROPHIES_COLS } from "@/lib/insights/trophies-board"
import { fetchSetSqueezeBoard, SET_SQUEEZE_COLS } from "@/lib/insights/set-squeeze-board"
import { fetchOfferSpreadBoard, OFFER_SPREAD_COLS } from "@/lib/insights/offer-spread-board"
import {
  fetchPinnacleScarcityBoard,
  PINNACLE_SCARCITY_COLS,
} from "@/lib/insights/pinnacle-scarcity-board"

// Five `/insights` board queries, each newly shared by its SERVER PAGE and its
// public API route instead of being copied into both (2026-08-15).
//
// These assert the QUERY SHAPE rather than results, because the shape is what
// the two consumers were duplicating and what drifts silently: the column list,
// the floors, and which column each sort key orders by. A wrong sort here
// reorders a public ranked board without erroring anywhere.
//
// ⚠ The SECONDARY orderings are asserted deliberately. A first draft of the
// squeeze module dropped the route's `squeeze_pct` tiebreaks, which would have
// changed the live route's row order for equal-valued rows — invisible in any
// test that only checks the primary sort. Rows equal on the primary key order
// arbitrarily without one, so the server-rendered HTML and the client's first
// refetch can disagree for identical data.
//
// The page's copy of each query lived in `app/**/page.tsx`, which NEITHER
// coverage gate measures. Moving it into `lib/` is what makes it testable at
// all — that is half the point of the extraction, the other half being that the
// pages come off `__tests__/server-page-data-access-ratchet.test.ts`.

type Call = { fn: string; args: unknown[] }

/** Records every builder call so the assembled query can be asserted. */
function recordingDb() {
  const calls: Call[] = []
  const q: Record<string, unknown> = {}
  for (const fn of ["select", "gte", "gt", "eq", "ilike", "lte", "order"]) {
    q[fn] = (...args: unknown[]) => {
      calls.push({ fn, args })
      return q
    }
  }
  q.limit = (...args: unknown[]) => {
    calls.push({ fn: "limit", args })
    return Promise.resolve({ data: [], error: null })
  }
  const db = {
    from: (...args: unknown[]) => {
      calls.push({ fn: "from", args })
      return q
    },
  }
  return { db, calls }
}

const has = (calls: Call[], fn: string, arg0?: unknown) =>
  calls.some((c) => c.fn === fn && (arg0 === undefined || c.args[0] === arg0))

/** The ordered list of columns passed to .order(), for tiebreak assertions. */
const orderCols = (calls: Call[]) =>
  calls.filter((c) => c.fn === "order").map((c) => c.args[0] as string)

// ⚠ ASSERTING `select === <THE EXPORTED CONSTANT>` IS SELF-REFERENTIAL AND
// PROVES NOTHING ABOUT THE COLUMNS. Deleting a column from the constant changes
// both sides of that comparison, so the mutation passes — verified, it SURVIVED.
// It is still worth keeping (it proves the query uses the shared list rather
// than an inline copy, which is the extraction's point), but the columns
// themselves need a literal expectation.
//
// These are the load-bearing ones: the identifier each row's drill-down link is
// built from, and the money/scarcity fields the client renders. Dropping any of
// them yields a board that renders with blank cells or dead links rather than an
// error — the failure mode this whole family of extractions exists to prevent.
const REQUIRED_COLS: Array<[string, string, string[]]> = [
  ["squeeze", SQUEEZE_COLS, ["external_id", "squeeze_pct", "circulation", "fmv_usd", "confidence", "low_ask"]],
  ["trophies", TROPHIES_COLS, ["external_id", "collection", "fmv_usd", "confidence", "circulation_count", "is_one_of_one", "is_ultimate"]],
  ["set-squeeze", SET_SQUEEZE_COLS, ["set_id", "set_name", "avg_squeeze_pct", "total_buyable", "avg_fmv_usd"]],
  ["offer-spread", OFFER_SPREAD_COLS, ["external_id", "highest_offer", "low_ask", "par_distance", "spread_usd", "bid_meets_ask"]],
  ["pinnacle-scarcity", PINNACLE_SCARCITY_COLS, ["render_id", "mint_count", "scarcity_vs_variant_pct", "fmv_usd", "fmv_confidence"]],
]

describe("shared column lists carry every column their consumers render", () => {
  it.each(REQUIRED_COLS)("%s", (_board, cols, required) => {
    const present = new Set(cols.split(",").map((c) => c.trim()))
    for (const col of required) {
      expect(present, `${col} must stay in the shared column list`).toContain(col)
    }
  })
})

describe("fetchSqueezeBoard", () => {
  it("reads the public view with the shared column list and the squeeze floor", async () => {
    const { db, calls } = recordingDb()
    await fetchSqueezeBoard({ limit: 200 }, db)
    expect(has(calls, "from", "topshot_squeeze_board")).toBe(true)
    expect(has(calls, "select", SQUEEZE_COLS)).toBe(true)
    // The floor is the board's premise, not a filter: without it the ranking is
    // every Top Shot edition rather than the squeezed ones.
    expect(calls.find((c) => c.fn === "gte")?.args).toEqual(["squeeze_pct", 50])
  })

  it("lets the caller move the floor without changing the query", async () => {
    const { db, calls } = recordingDb()
    await fetchSqueezeBoard({ limit: 50, minSqueeze: 80 }, db)
    expect(calls.find((c) => c.fn === "gte")?.args).toEqual(["squeeze_pct", 80])
  })

  it("orders squeeze desc then circulation asc by default", async () => {
    const { db, calls } = recordingDb()
    await fetchSqueezeBoard({ limit: 200 }, db)
    expect(orderCols(calls)).toEqual(["squeeze_pct", "circulation"])
  })

  it.each([
    ["circulation", ["circulation", "squeeze_pct"]],
    ["fmv", ["fmv_usd", "squeeze_pct"]],
    ["buyable", ["effectively_buyable", "squeeze_pct"]],
  ])("keeps the squeeze_pct tiebreak on sort=%s", async (sort, expected) => {
    const { db, calls } = recordingDb()
    await fetchSqueezeBoard({ limit: 200, sort }, db)
    expect(orderCols(calls)).toEqual(expected)
  })

  it("applies the optional filters only when supplied", async () => {
    const bare = recordingDb()
    await fetchSqueezeBoard({ limit: 10 }, bare.db)
    expect(has(bare.calls, "eq")).toBe(false)
    expect(has(bare.calls, "ilike")).toBe(false)
    expect(has(bare.calls, "lte")).toBe(false)

    const full = recordingDb()
    await fetchSqueezeBoard(
      { limit: 10, tier: "legendary", set: "Origins", player: "Lillard", maxBuyable: 10, maxCirculation: 100 },
      full.db,
    )
    // Tier is UPPERCASED: fmv/tier enums are uppercase and `.eq` is exact, so a
    // lowercase query param would silently return nothing.
    expect(full.calls.find((c) => c.fn === "eq")?.args).toEqual(["tier", "LEGENDARY"])
    expect(has(full.calls, "ilike", "set_name")).toBe(true)
    expect(has(full.calls, "ilike", "player_name")).toBe(true)
    expect(has(full.calls, "lte", "effectively_buyable")).toBe(true)
    expect(has(full.calls, "lte", "circulation")).toBe(true)
  })

  it("returns supabase's { data, error } untouched so callers keep their own policy", async () => {
    const err = { message: "canceling statement due to statement timeout" }
    const db = { from: () => ({ select: () => ({ gte: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: err }) }) }) }) }) }) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fetchSqueezeBoard({ limit: 5 }, db as any)
    // The route turns this into a 503 with no driver message; the page turns it
    // into `ok:false`. Normalising here would force one of them to re-derive it.
    expect(res.error).toBe(err)
    expect(res.data).toBeNull()
  })
})

describe("fetchTrophiesBoard", () => {
  it("reads the grails view with the shared column list", async () => {
    const { db, calls } = recordingDb()
    await fetchTrophiesBoard({ limit: 200 }, db)
    expect(has(calls, "from", "v_insights_trophies")).toBe(true)
    expect(has(calls, "select", TROPHIES_COLS)).toBe(true)
  })

  it("ranks priced grails first, never-traded ones after", async () => {
    const { db, calls } = recordingDb()
    await fetchTrophiesBoard({ limit: 200 }, db)
    expect(orderCols(calls)).toEqual(["fmv_usd", "circulation_count"])
    // nullsFirst:false is what puts the never-traded grails AFTER the priced
    // ones. Flipping it leads the board with rows that have no number at all.
    expect(calls.find((c) => c.fn === "order")?.args[1]).toMatchObject({ nullsFirst: false })
  })

  it("switches the primary key on sort=circulation but keeps a tiebreak", async () => {
    const { db, calls } = recordingDb()
    await fetchTrophiesBoard({ limit: 200, sort: "circulation" }, db)
    expect(orderCols(calls)).toEqual(["circulation_count", "fmv_usd"])
  })

  it("maps the two grail classes to their own flags, not to one another", async () => {
    const one = recordingDb()
    await fetchTrophiesBoard({ limit: 10, type: "one_of_one" }, one.db)
    expect(one.calls.find((c) => c.fn === "eq")?.args).toEqual(["is_one_of_one", true])

    const ult = recordingDb()
    await fetchTrophiesBoard({ limit: 10, type: "ultimate" }, ult.db)
    expect(ult.calls.find((c) => c.fn === "eq")?.args).toEqual(["is_ultimate", true])

    // An unrecognised type must not silently filter to one of the two classes.
    const junk = recordingDb()
    await fetchTrophiesBoard({ limit: 10, type: "nonsense" }, junk.db)
    expect(has(junk.calls, "eq")).toBe(false)
  })
})

describe("fetchSetSqueezeBoard", () => {
  it("reads the set-level view with the shared column list", async () => {
    const { db, calls } = recordingDb()
    await fetchSetSqueezeBoard({ limit: 100 }, db)
    expect(has(calls, "from", "topshot_set_squeeze_board")).toBe(true)
    expect(has(calls, "select", SET_SQUEEZE_COLS)).toBe(true)
    expect(orderCols(calls)).toEqual(["avg_squeeze_pct"])
  })

  it("sorts by total_buyable when asked for anything else", async () => {
    const { db, calls } = recordingDb()
    await fetchSetSqueezeBoard({ limit: 100, sort: "buyable" }, db)
    expect(orderCols(calls)).toEqual(["total_buyable"])
  })

  it("treats series 0 as a real filter, not as absent", async () => {
    // Top Shot Series 1 is on-chain `0`, so a truthiness check here would drop
    // the filter for the platform's oldest series. The guard is `!= null`.
    const { db, calls } = recordingDb()
    await fetchSetSqueezeBoard({ limit: 100, series: 0 }, db)
    expect(calls.find((c) => c.fn === "eq")?.args).toEqual(["series", 0])
  })
})

describe("fetchOfferSpreadBoard", () => {
  it("applies the dust floor on low_ask", async () => {
    const { db, calls } = recordingDb()
    await fetchOfferSpreadBoard({ limit: 200 }, db)
    expect(has(calls, "from", "topshot_offer_ask_spread")).toBe(true)
    expect(has(calls, "select", OFFER_SPREAD_COLS)).toBe(true)
    // Below the floor the spread percentages are dominated by dust asks, so an
    // unfloored board ranks noise at the top of a surface whose whole claim is
    // "these bids are closest to their ask".
    expect(calls.find((c) => c.fn === "gte")?.args).toEqual(["low_ask", 5])
  })

  it.each([
    ["par", "par_distance"],
    ["spread", "spread_usd"],
    ["offer", "highest_offer"],
    ["ask", "low_ask"],
    ["pct", "offer_pct_of_ask"],
  ])("sort=%s orders by %s", async (sort, col) => {
    const { db, calls } = recordingDb()
    await fetchOfferSpreadBoard({ limit: 200, sort }, db)
    expect(orderCols(calls)).toEqual([col])
  })

  it("only narrows to bid-meets-ask when the caller asks", async () => {
    const off = recordingDb()
    await fetchOfferSpreadBoard({ limit: 10 }, off.db)
    expect(has(off.calls, "eq", "bid_meets_ask")).toBe(false)

    const on = recordingDb()
    await fetchOfferSpreadBoard({ limit: 10, bidMeetsAsk: true }, on.db)
    expect(has(on.calls, "eq", "bid_meets_ask")).toBe(true)
  })
})

describe("fetchPinnacleScarcityBoard", () => {
  it("reads the Pinnacle view with the shared column list", async () => {
    const { db, calls } = recordingDb()
    await fetchPinnacleScarcityBoard({ limit: 100 }, db)
    expect(has(calls, "from", "pinnacle_scarcity_board")).toBe(true)
    expect(has(calls, "select", PINNACLE_SCARCITY_COLS)).toBe(true)
    expect(orderCols(calls)).toEqual(["scarcity_vs_variant_pct"])
  })

  it.each([
    ["mint", "mint_count"],
    ["fmv", "fmv_usd"],
  ])("sort=%s orders by %s", async (sort, col) => {
    const { db, calls } = recordingDb()
    await fetchPinnacleScarcityBoard({ limit: 100, sort }, db)
    expect(orderCols(calls)).toEqual([col])
  })

  it("treats maxMint 0 as a real bound rather than dropping the filter", async () => {
    const { db, calls } = recordingDb()
    await fetchPinnacleScarcityBoard({ limit: 100, maxMint: 0 }, db)
    expect(calls.find((c) => c.fn === "lte")?.args).toEqual(["mint_count", 0])
  })

  it("ignores a non-finite maxMint instead of sending NaN to Postgres", async () => {
    // `Number(sp.get("max_mint"))` yields NaN for junk input, and a NaN bound
    // would make the board return nothing while looking like a filter worked.
    const { db, calls } = recordingDb()
    await fetchPinnacleScarcityBoard({ limit: 100, maxMint: Number("abc") }, db)
    expect(has(calls, "lte")).toBe(false)
  })
})
