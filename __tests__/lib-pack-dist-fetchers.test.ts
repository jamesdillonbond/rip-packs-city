import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Tests for lib/pack-dist/fetchers.ts — the data-access layer extracted out of
// app/(collections)/[collection]/pack/dist/[distId]/page.tsx on 2026-08-13.
//
// The extraction existed to make two things testable that previously were not:
//
//  1. COVERAGE. That page is ~2,700 lines of `app/**/page.tsx`, a tree measured
//     by NEITHER coverage gate, and it held the largest single concentration of
//     unmeasured Supabase access in the repo (11 fetchers).
//
//  2. HONESTY. Most of those fetchers returned `[]` / `0` on a query ERROR, and
//     the page renders those as positive claims about the catalogue. The sharpest
//     one: an empty top-pulls list prints "Drop-pool contents aren't indexed for
//     this distribution yet" — so a statement timeout told a visitor our index was
//     missing data it in fact holds. Every `ok: false` assertion below is the
//     regression floor for that class.
//
// The distinction that carries the most weight here is the THIRD state. A section
// that does not APPLY to the collection (Top-Shot-only panels on an All Day pack)
// must be `ok: true`, not a failure — otherwise every All Day pack page carries a
// permanent "some data unavailable" banner, which is the cry-wolf outcome
// lib/insights/board-status.ts explicitly warns against. Those cases are asserted
// as loudly as the error cases.

import {
  fetchPackDetailBundle,
  fetchPackRow,
  fetchDistFallback,
  fetchPackLifecycle,
  fetchPackRealizedEv,
  fetchAllDayCorrectedEv,
  fetchPackMarket,
  fetchEvContributors,
  fetchTopPulls,
  fetchPackContents,
  fetchExhaustedCount,
  fetchPackSalesHistory,
} from "@/lib/pack-dist/fetchers"

type Payload = { data?: unknown; error?: unknown; count?: number | null }

/**
 * Minimal Supabase double.
 *
 * Deliberately NOT __tests__/helpers/route-harness.ts's makeSupabaseFixture: that
 * helper's `.rpc()` is an async function returning the payload directly, and three
 * fetchers here call `.rpc(...).maybeSingle()`, which needs the RPC result to be a
 * *thenable builder*. Modelling that faithfully matters — `.rpc().maybeSingle()`
 * vs bare `.rpc()` is a real behavioural difference in the code under test (the
 * bare form can return an array that must be unwrapped).
 */
function makeDb(fixtures: Record<string, Payload>) {
  const calls: string[] = []
  const get = (key: string): Payload => {
    calls.push(key)
    return fixtures[key] ?? { data: null, error: null }
  }
  const thenable = (key: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "gt", "order", "limit", "in"]) {
      b[m] = () => b
    }
    b.maybeSingle = async () => get(key)
    b.single = async () => get(key)
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(get(key)).then(onF, onR)
    return b
  }
  return {
    db: {
      from: (table: string) => thenable(table),
      rpc: (name: string) => thenable(`rpc:${name}`),
    },
    calls,
  }
}

const DB_ERR = { message: "canceling statement due to statement timeout" }

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── The shell bundle: the one deliberate exception to the contract ──────────

describe("fetchPackDetailBundle keeps the error rather than flattening it to ok", () => {
  it("returns the bundle and a null error on success", async () => {
    const { db } = makeDb({
      "rpc:get_pack_detail_bundle": {
        data: { pack_row: { dist_id: "1" }, dist_fallback: null, has_pool: true },
        error: null,
      },
    })
    const res = await fetchPackDetailBundle("c", "1", "nba-top-shot", db)
    expect(res.error).toBeNull()
    expect(res.bundle.pack_row).toMatchObject({ dist_id: "1" })
    expect(res.bundle.has_pool).toBe(true)
  })

  it("surfaces the error MESSAGE, because the caller puts it in the thrown error", async () => {
    // This is why the bundle does not use `{ ok }` like its siblings. The page's
    // gate is: no row AND no fallback AND an error → THROW (retryable boundary);
    // no row AND no fallback AND no error → notFound(). Flattening to a boolean
    // would still separate those two, but would discard the message — and that
    // message is what tells an operator whether a wave of pack 404s was a
    // statement timeout or a genuine catalogue gap.
    const { db } = makeDb({
      "rpc:get_pack_detail_bundle": { data: null, error: { message: "statement timeout" } },
    })
    const res = await fetchPackDetailBundle("c", "1", "nba-top-shot", db)
    expect(res.error).toEqual({ message: "statement timeout" })
    // An errored bundle must still be a safely-destructurable object, or the
    // page's `bundle.pack_row` read throws before it can reach its own gate.
    expect(res.bundle).toEqual({})
  })

  it("normalises a null payload to an empty object", async () => {
    const { db } = makeDb({ "rpc:get_pack_detail_bundle": { data: null, error: null } })
    const res = await fetchPackDetailBundle("c", "1", "nba-top-shot", db)
    expect(res.bundle).toEqual({})
    expect(res.error).toBeNull()
  })
})

// ── The core contract, asserted uniformly ───────────────────────────────────

describe("every fetcher separates a failed read from an empty one", () => {
  it("fetchPackRow: error → ok:false, absent → ok:true, present → the row", async () => {
    const err = makeDb({ pack_table_rows: { data: null, error: DB_ERR } })
    expect(await fetchPackRow("c", "1", err.db)).toEqual({ data: null, ok: false })

    const absent = makeDb({ pack_table_rows: { data: null, error: null } })
    expect(await fetchPackRow("c", "1", absent.db)).toEqual({ data: null, ok: true })

    const present = makeDb({ pack_table_rows: { data: { dist_id: "1" }, error: null } })
    const res = await fetchPackRow("c", "1", present.db)
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ dist_id: "1" })
  })

  it("fetchDistFallback: error → ok:false, absent → ok:true", async () => {
    const err = makeDb({ pack_distributions: { data: null, error: DB_ERR } })
    expect(await fetchDistFallback("c", "1", err.db)).toEqual({ data: null, ok: false })

    const absent = makeDb({ pack_distributions: { data: null, error: null } })
    expect(await fetchDistFallback("c", "1", absent.db)).toEqual({ data: null, ok: true })
  })

  it("fetchPackContents: error → ok:false; a non-array payload degrades to []", async () => {
    const err = makeDb({ "rpc:get_pack_contents": { data: null, error: DB_ERR } })
    expect(await fetchPackContents("c", "1", 24, 0, err.db)).toEqual({ rows: [], ok: false })

    const weird = makeDb({ "rpc:get_pack_contents": { data: { not: "an array" }, error: null } })
    expect(await fetchPackContents("c", "1", 24, 0, weird.db)).toEqual({ rows: [], ok: true })
  })

  it("fetchPackSalesHistory: error → ok:false, rows → ok:true", async () => {
    const err = makeDb({ "rpc:get_pack_sales_history": { data: null, error: DB_ERR } })
    expect(await fetchPackSalesHistory("c", "1", 10, err.db)).toEqual({ rows: [], ok: false })

    const ok = makeDb({ "rpc:get_pack_sales_history": { data: [{ kind: "top" }], error: null } })
    const res = await fetchPackSalesHistory("c", "1", 10, ok.db)
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
  })
})

// ── The zero that was being manufactured from a failure ─────────────────────

describe("fetchExhaustedCount does not publish a failure as a measured zero", () => {
  it("reports ok:false when the count query errors", async () => {
    // The count still reads 0 because the caller needs a number to render, but
    // `ok:false` is what stops the page presenting that 0 as a fact. Before the
    // extraction this returned a bare `0` and the section header printed it.
    const { db } = makeDb({ pack_drop_pool: { count: null, error: DB_ERR } })
    expect(await fetchExhaustedCount("c", "1", db)).toEqual({ count: 0, ok: false })
  })

  it("a genuine zero is ok:true", async () => {
    const { db } = makeDb({ pack_drop_pool: { count: 0, error: null } })
    expect(await fetchExhaustedCount("c", "1", db)).toEqual({ count: 0, ok: true })
  })

  it("passes a real count through", async () => {
    const { db } = makeDb({ pack_drop_pool: { count: 37, error: null } })
    expect(await fetchExhaustedCount("c", "1", db)).toEqual({ count: 37, ok: true })
  })
})

// ── The headline defect ─────────────────────────────────────────────────────

describe("fetchTopPulls — a failed pool read must not read as an unindexed pool", () => {
  it("propagates the pool error as ok:false", async () => {
    // This is the assertion that matters most in the file. The caller renders
    // "Drop-pool contents aren't indexed for this distribution yet" on an empty
    // list; if this ever returns ok:true again, that sentence starts being
    // printed for outages on packs whose pool is fully indexed.
    const { db } = makeDb({ pack_drop_pool: { data: null, error: DB_ERR } })
    const res = await fetchTopPulls("c", "1", 100, 5, db)
    expect(res.ok).toBe(false)
    expect(res.rows).toEqual([])
    expect(res.partial).toBe(false)
  })

  it("a genuinely empty pool is ok:true (that sentence is TRUE here)", async () => {
    const { db } = makeDb({ pack_drop_pool: { data: [], error: null } })
    const res = await fetchTopPulls("c", "1", 100, 5, db)
    expect(res).toEqual({ rows: [], ok: true, partial: false })
  })

  it("short-circuits before the follow-up reads when the pool is empty", async () => {
    // Guards against a refactor that fires three more queries per empty pack.
    const { db, calls } = makeDb({ pack_drop_pool: { data: [], error: null } })
    await fetchTopPulls("c", "1", 100, 5, db)
    expect(calls).toEqual(["pack_drop_pool"])
  })

  it("computes rows on the happy path", async () => {
    const { db } = makeDb({
      pack_drop_pool: { data: [{ edition_id: "e1", drop_weight: 10 }], error: null },
      editions: {
        data: [
          { id: "e1", name: "A — B", tier: "RARE", external_id: "1:2", player_name: "A", set_name: "B" },
        ],
        error: null,
      },
      "rpc:get_fmv_for_editions": { data: [{ edition_id: "e1", fmv_usd: 100 }], error: null },
      "rpc:query_sql": { data: [{ total_weight: 40 }], error: null },
    })
    const res = await fetchTopPulls("c", "1", null, 5, db)
    expect(res.ok).toBe(true)
    expect(res.partial).toBe(false)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].editionId).toBe("e1")
    expect(res.rows[0].fmvUsd).toBe(100)
  })

  it("a follow-up read failing is PARTIAL, not failed — the rows still render honestly", async () => {
    // computeTopPulls degrades per-field (blank player / null EV / null
    // probability, all rendered as em-dashes), so the section is genuinely
    // usable. Marking it ok:false would blank a panel that is telling the truth;
    // marking it fully ok would hide that the percentages are missing.
    const { db } = makeDb({
      pack_drop_pool: { data: [{ edition_id: "e1", drop_weight: 10 }], error: null },
      editions: { data: null, error: DB_ERR },
      "rpc:get_fmv_for_editions": { data: [{ edition_id: "e1", fmv_usd: 100 }], error: null },
      "rpc:query_sql": { data: [{ total_weight: 40 }], error: null },
    })
    const res = await fetchTopPulls("c", "1", null, 5, db)
    expect(res.ok).toBe(true)
    expect(res.partial).toBe(true)
    expect(res.rows).toHaveLength(1)
  })

  it("flags partial when the pool-weight denominator read fails", async () => {
    // Audit B2: without the full-pool weight the probability column must go
    // null rather than fall back to summing the top-50 (which inflates it).
    const { db } = makeDb({
      pack_drop_pool: { data: [{ edition_id: "e1", drop_weight: 10 }], error: null },
      editions: { data: [], error: null },
      "rpc:get_fmv_for_editions": { data: [], error: null },
      "rpc:query_sql": { data: null, error: DB_ERR },
    })
    const res = await fetchTopPulls("c", "1", null, 5, db)
    expect(res.partial).toBe(true)
    expect(res.rows[0]?.probabilityPct).toBeNull()
  })
})

// ── "Not applicable" is not a failure ───────────────────────────────────────

describe("a section that does not apply to the collection reports ok:true", () => {
  it.each([
    ["fetchPackLifecycle", () => fetchPackLifecycle("laliga-golazos", "1", makeDb({}).db)],
    ["fetchPackRealizedEv", () => fetchPackRealizedEv("laliga-golazos", "1", makeDb({}).db)],
    ["fetchAllDayCorrectedEv", () => fetchAllDayCorrectedEv("nba-top-shot", "1", makeDb({}).db)],
    ["fetchPackMarket", () => fetchPackMarket("laliga-golazos", "1", makeDb({}).db)],
  ])("%s", async (_name, run) => {
    const res = await run()
    expect(res).toEqual({ data: null, ok: true })
  })

  it("fetchEvContributors on a non-Top-Shot collection", async () => {
    expect(await fetchEvContributors("nfl-all-day", "1", makeDb({}).db)).toEqual({ rows: [], ok: true })
  })

  it("issues no query at all for an inapplicable collection", async () => {
    const { db, calls } = makeDb({})
    await fetchPackMarket("laliga-golazos", "1", db)
    await fetchEvContributors("nfl-all-day", "1", db)
    await fetchAllDayCorrectedEv("nba-top-shot", "1", db)
    expect(calls).toEqual([])
  })
})

// ── Per-collection branches ─────────────────────────────────────────────────

describe("fetchPackLifecycle", () => {
  it("maps the All Day view into the shared shape, deriving sealed = minted − opened", async () => {
    const { db } = makeDb({
      v_allday_pack_lifecycle: {
        data: {
          packs_opened: 40,
          minted: 100,
          moments_pulled: 200,
          realized_pull_value_usd: 500,
          avg_realized_value_per_pack: 12.5,
          opened_pct_of_minted: 40,
        },
        error: null,
      },
    })
    const res = await fetchPackLifecycle("nfl-all-day", "1", db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      packs_opened: 40,
      packs_opened_confirmed: 40, // every All Day open is on-chain confirmed
      packs_opened_inferred: 0,
      packs_sealed_observed: 60,
      observed_depletion_pct: 40,
    })
  })

  it("leaves sealed null rather than going negative when opened exceeds minted", async () => {
    const { db } = makeDb({
      v_allday_pack_lifecycle: { data: { packs_opened: 120, minted: 100 }, error: null },
    })
    const res = await fetchPackLifecycle("nfl-all-day", "1", db)
    expect(res.data?.packs_sealed_observed).toBeNull()
  })

  it("leaves sealed null when minted is unknown", async () => {
    const { db } = makeDb({
      v_allday_pack_lifecycle: { data: { packs_opened: 40, minted: null }, error: null },
    })
    expect((await fetchPackLifecycle("nfl-all-day", "1", db)).data?.packs_sealed_observed).toBeNull()
  })

  it("All Day: error → ok:false, absent row → ok:true", async () => {
    const err = makeDb({ v_allday_pack_lifecycle: { data: null, error: DB_ERR } })
    expect(await fetchPackLifecycle("nfl-all-day", "1", err.db)).toEqual({ data: null, ok: false })

    const absent = makeDb({ v_allday_pack_lifecycle: { data: null, error: null } })
    expect(await fetchPackLifecycle("nfl-all-day", "1", absent.db)).toEqual({ data: null, ok: true })
  })

  it("Top Shot: reads the per-dist RPC and separates error from absence", async () => {
    const err = makeDb({ "rpc:get_pack_lifecycle_row": { data: null, error: DB_ERR } })
    expect(await fetchPackLifecycle("nba-top-shot", "1", err.db)).toEqual({ data: null, ok: false })

    const ok = makeDb({ "rpc:get_pack_lifecycle_row": { data: { packs_opened: 7 }, error: null } })
    const res = await fetchPackLifecycle("nba-top-shot", "1", ok.db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ packs_opened: 7 })
  })
})

describe("fetchPackRealizedEv", () => {
  it("maps the All Day view, nulling the columns that view does not carry", async () => {
    const { db } = makeDb({
      v_allday_pack_realized_ev: {
        data: {
          modeled_gross_ev: 30,
          n_opens: 25,
          realized_mean: 21,
          realized_median: 18,
          realized_to_modeled_ratio: 0.7,
        },
        error: null,
      },
    })
    const res = await fetchPackRealizedEv("nfl-all-day", "1", db)
    expect(res.ok).toBe(true)
    // p90 and calibrated_ev do not exist on the All Day view — they must be
    // null, never silently borrowed from another field.
    expect(res.data).toMatchObject({ realized_p90: null, calibrated_ev: null, n_opens: 25 })
  })

  it("All Day: error → ok:false; absent → ok:true", async () => {
    const err = makeDb({ v_allday_pack_realized_ev: { data: null, error: DB_ERR } })
    expect(await fetchPackRealizedEv("nfl-all-day", "1", err.db)).toEqual({ data: null, ok: false })

    const absent = makeDb({ v_allday_pack_realized_ev: { data: null, error: null } })
    expect(await fetchPackRealizedEv("nfl-all-day", "1", absent.db)).toEqual({ data: null, ok: true })
  })

  it("Top Shot: RPC error → ok:false", async () => {
    const { db } = makeDb({ "rpc:get_pack_realized_ev_row": { data: null, error: DB_ERR } })
    expect(await fetchPackRealizedEv("nba-top-shot", "1", db)).toEqual({ data: null, ok: false })
  })
})

describe("fetchAllDayCorrectedEv", () => {
  it("reads the lean detail view and returns the row", async () => {
    const { db, calls } = makeDb({
      v_allday_pack_detail_ev: { data: { corrected_gross_ev: 12 }, error: null },
    })
    const res = await fetchAllDayCorrectedEv("nfl-all-day", "1", db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ corrected_gross_ev: 12 })
    // Must stay on v_allday_pack_detail_ev, not v_allday_pack_info: the latter's
    // dist_id predicate cannot push below its DISTINCT ON, scanning 119k rows
    // per request for a column no caller reads (per-dist cost 1,195,280 → 7.54).
    expect(calls).toEqual(["v_allday_pack_detail_ev"])
  })

  it("error → ok:false", async () => {
    const { db } = makeDb({ v_allday_pack_detail_ev: { data: null, error: DB_ERR } })
    expect(await fetchAllDayCorrectedEv("nfl-all-day", "1", db)).toEqual({ data: null, ok: false })
  })
})

describe("fetchPackMarket", () => {
  it("unwraps the first row when the RPC returns an array", async () => {
    const { db } = makeDb({ "rpc:get_pack_market_row": { data: [{ n_sales: 4 }], error: null } })
    const res = await fetchPackMarket("nba-top-shot", "1", db)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ n_sales: 4 })
  })

  it("accepts a bare object too", async () => {
    const { db } = makeDb({ "rpc:get_pack_market_row": { data: { n_sales: 9 }, error: null } })
    expect((await fetchPackMarket("nfl-all-day", "1", db)).data).toMatchObject({ n_sales: 9 })
  })

  it("an empty array is an absence, not a failure", async () => {
    const { db } = makeDb({ "rpc:get_pack_market_row": { data: [], error: null } })
    expect(await fetchPackMarket("nba-top-shot", "1", db)).toEqual({ data: null, ok: true })
  })

  it("error → ok:false", async () => {
    const { db } = makeDb({ "rpc:get_pack_market_row": { data: null, error: DB_ERR } })
    expect(await fetchPackMarket("nba-top-shot", "1", db)).toEqual({ data: null, ok: false })
  })
})

describe("fetchEvContributors", () => {
  it("Top Shot: rows through on success", async () => {
    const { db } = makeDb({
      "rpc:get_pack_ev_contributors": { data: [{ edition_id: "e1" }, { edition_id: "e2" }], error: null },
    })
    const res = await fetchEvContributors("nba-top-shot", "1", db)
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(2)
  })

  it("Top Shot: error → ok:false", async () => {
    const { db } = makeDb({ "rpc:get_pack_ev_contributors": { data: null, error: DB_ERR } })
    expect(await fetchEvContributors("nba-top-shot", "1", db)).toEqual({ rows: [], ok: false })
  })

  it("a non-array payload degrades to [] without claiming failure", async () => {
    const { db } = makeDb({ "rpc:get_pack_ev_contributors": { data: { oops: true }, error: null } })
    expect(await fetchEvContributors("nba-top-shot", "1", db)).toEqual({ rows: [], ok: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDS — a read that HANGS must reach the same `ok: false` these fetchers
// already return for an error.
//
// 🚨 THIS PAGE IS THE TOP USER-IMPACTING ERROR IN PRODUCTION. Vercel's 24h window
// on 2026-08-23: `[pack-detail] pack_realized_ev … statement timeout` at **124
// users**, `pack_lifecycle` at 86, `ev_contributors` at 26, `pack_table_rows` at
// 22. Those are the reads that ANSWERED with an error, and every `ok: false`
// assertion above is the floor for them. The ones that merely HANG answer nothing
// — supabase-js resolves `{ data, error }` only when the query finishes — so the
// page waits on a streaming shell Vercel logs as a 200.
//
// ⚠ ONE read here was already bounded (`get_pack_detail_bundle`, via
// `rpcWithRetry`) and THIRTEEN were not. That asymmetry is why
// `scripts/check-unbounded-server-reads.mjs` deliberately does NOT recognise
// `rpcWithRetry` as a budget primitive: doing so would have cleared this whole
// page on the strength of the one bounded read.
//
// ⚠ The bound RESOLVES rather than rejecting, because every call site is a bare
// `await` followed by `if (error)` with no try/catch to reject into. A rejection
// would escape and render an error boundary instead of a page. These assertions
// therefore check the fetcher's own contract, not that a throw was caught.
// ─────────────────────────────────────────────────────────────────────────────

/** A double whose every terminal call never settles. */
function hangingDb() {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "order", "limit", "in"]) b[m] = () => b
  b.maybeSingle = () => new Promise(() => {})
  b.single = () => new Promise(() => {})
  b.then = () => new Promise(() => {})
  return { from: () => b, rpc: () => b }
}

describe("bounds — a hung read is not an unindexed pack", () => {
  it("fetchPackRealizedEv reports ok:false rather than hanging", async () => {
    const res = await fetchPackRealizedEv("nba-top-shot", "d1", hangingDb())

    expect(res.ok, "an overrun read must report FAILURE").toBe(false)
    // ⚠ The absence of the false claim, not just the presence of a flag.
    expect(res.data === null && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchPackLifecycle reports ok:false rather than hanging", async () => {
    const res = await fetchPackLifecycle("nba-top-shot", "d1", hangingDb())

    expect(res.ok).toBe(false)
    expect(res.data === null && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchEvContributors reports ok:false rather than hanging — in the ROWS shape", async () => {
    const res = await fetchEvContributors("nba-top-shot", "d1", hangingDb())

    expect(res.ok).toBe(false)
    expect(res.rows).toEqual([])
    expect(res.rows.length === 0 && res.ok === true).toBe(false)
  }, 20_000)

  it("fetchExhaustedCount reports ok:false rather than hanging — in the COUNT shape", async () => {
    // ⚠ The one caller that destructures `count`, not `data`. The shared bound
    // supplies all three fields, and this is what proves that envelope reaches
    // the count-shaped site too rather than leaving `count` undefined.
    const res = await fetchExhaustedCount("c1", "d1", hangingDb())

    expect(res.ok).toBe(false)
  }, 20_000)

  it("CONTROL — a read inside the budget still resolves normally", async () => {
    // Without this, a bound that failed unconditionally would satisfy every
    // assertion above while the module had stopped working entirely.
    const { db } = makeDb({ "rpc:get_pack_ev_contributors": { data: [{ edition_id: "e1" }] } })
    const res = await fetchEvContributors("nba-top-shot", "d1", db)

    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
  })

  it("CONTROL — a section that does not APPLY is still ok:true, not a failure", async () => {
    // The third state this file's header calls the one carrying the most weight:
    // a Top-Shot-only panel on an All Day pack must not read as an outage, or
    // every All Day pack page carries a permanent "unavailable" banner.
    const res = await fetchEvContributors("nfl-all-day", "d1", hangingDb())

    expect(res).toEqual({ rows: [], ok: true })
  })
})
