import { describe, it, expect, vi, afterEach } from "vitest"
import {
  bucketPackRealityRows,
  fetchPackRealityBuckets,
  FOSSIL_EV_TO_PRICE_MAX,
  OVER_MAX_RATIO,
  UNDER_MIN_RATIO,
  ON_MODEL_MIN_RATIO,
  ON_MODEL_MAX_RATIO,
  OVER_MIN_MODELED_EV,
  UNDER_MIN_MODELED_EV,
  MIN_OPENS,
  RANK_LIMIT,
  type PackRealityRow,
} from "@/lib/insights/pack-reality-board"

// The PACK REALITY board — "the model says $X, packs actually pull $Y."
//
// ⚠ This is an honesty board about OUR OWN pack-EV model, and every threshold
// here decides which distributions a collector is shown as evidence the model is
// wrong. It lived in a `page.tsx` measured by neither coverage gate, so none of
// it had a test.

function row(p: Partial<PackRealityRow> & { dist_id: string }): PackRealityRow {
  return {
    title: null,
    pack_price: 10,
    modeled_gross_ev: 10,
    ev_method: null,
    n_opens: 50,
    n_valued: 50,
    realized_mean: null,
    realized_median: null,
    realized_to_modeled_ratio: 1,
    ...p,
  }
}

describe("bucketPackRealityRows — the three buckets", () => {
  it("splits over / under / on-model by the realized-to-modeled ratio", () => {
    const b = bucketPackRealityRows([
      row({ dist_id: "over", realized_to_modeled_ratio: 0.3 }),
      row({ dist_id: "under", realized_to_modeled_ratio: 3 }),
      row({ dist_id: "on", realized_to_modeled_ratio: 1 }),
    ])
    expect(b.over.map((r) => r.dist_id)).toEqual(["over"])
    expect(b.under.map((r) => r.dist_id)).toEqual(["under"])
    expect(b.onModel.map((r) => r.dist_id)).toEqual(["on"])
  })

  it("leaves the gaps between the bands EMPTY rather than forcing every row into a bucket", () => {
    // ⚠ 0.6–0.8 and 1.25–1.8 belong to nothing, deliberately: the board's claim
    // is "the model is clearly wrong here" / "clearly right here", and a row in
    // between supports neither. Widening any band to close a gap would put
    // ambiguous evidence under a confident heading.
    const b = bucketPackRealityRows([
      row({ dist_id: "tweener-low", realized_to_modeled_ratio: 0.7 }),
      row({ dist_id: "tweener-high", realized_to_modeled_ratio: 1.5 }),
    ])
    expect(b.over).toEqual([])
    expect(b.under).toEqual([])
    expect(b.onModel).toEqual([])
    expect(b.qualifying, "they still count as qualifying rows").toBe(2)
  })

  // ⚠ EVERY BOUNDARY, from both sides. These constants ARE the board's claims.
  it("pins each band edge, including which side is inclusive", () => {
    const b = bucketPackRealityRows([
      // over is STRICT (<): exactly 0.6 is not over-valued.
      row({ dist_id: "over-edge", realized_to_modeled_ratio: OVER_MAX_RATIO }),
      row({ dist_id: "over-in", realized_to_modeled_ratio: OVER_MAX_RATIO - 0.001 }),
      // under is STRICT (>): exactly 1.8 is not under-valued.
      row({ dist_id: "under-edge", realized_to_modeled_ratio: UNDER_MIN_RATIO }),
      row({ dist_id: "under-in", realized_to_modeled_ratio: UNDER_MIN_RATIO + 0.001 }),
      // on-model is INCLUSIVE on both ends.
      row({ dist_id: "on-lo", realized_to_modeled_ratio: ON_MODEL_MIN_RATIO }),
      row({ dist_id: "on-hi", realized_to_modeled_ratio: ON_MODEL_MAX_RATIO }),
      row({ dist_id: "on-below", realized_to_modeled_ratio: ON_MODEL_MIN_RATIO - 0.001 }),
      row({ dist_id: "on-above", realized_to_modeled_ratio: ON_MODEL_MAX_RATIO + 0.001 }),
    ])
    expect(b.over.map((r) => r.dist_id)).toEqual(["over-in"])
    expect(b.under.map((r) => r.dist_id)).toEqual(["under-in"])
    expect(b.onModel.map((r) => r.dist_id).sort()).toEqual(["on-hi", "on-lo"])
  })
})

describe("bucketPackRealityRows — the asymmetries, which are the point", () => {
  it("⚠ the FOSSIL guard applies to `over` ONLY", () => {
    // A depleted pool models far above its price (CLAUDE.md: 40–86×) and by
    // construction looks like a massive over-valuation — so without this guard
    // the "model over-values" board would be nothing BUT fossils and the real
    // over-valuations would be pushed off it.
    const fossil = {
      pack_price: 10,
      modeled_gross_ev: 10 * FOSSIL_EV_TO_PRICE_MAX + 1, // past the guard
    }
    const b = bucketPackRealityRows([
      row({ dist_id: "fossil-over", ...fossil, realized_to_modeled_ratio: 0.1 }),
      row({ dist_id: "real-over", realized_to_modeled_ratio: 0.1 }),
      // ...and the SAME fossil shape is admitted to the other two buckets,
      // because a fossil is not a plausible member of either and guarding there
      // would exclude nothing while implying the lists are filtered alike.
      row({ dist_id: "fossil-under", ...fossil, realized_to_modeled_ratio: 3 }),
      row({ dist_id: "fossil-on", ...fossil, realized_to_modeled_ratio: 1 }),
    ])
    expect(b.over.map((r) => r.dist_id)).toEqual(["real-over"])
    expect(b.under.map((r) => r.dist_id)).toContain("fossil-under")
    expect(b.onModel.map((r) => r.dist_id)).toContain("fossil-on")
  })

  it("the fossil guard is INCLUSIVE at exactly 1.5× price", () => {
    const b = bucketPackRealityRows([
      row({
        dist_id: "on-the-line",
        pack_price: 10,
        modeled_gross_ev: 10 * FOSSIL_EV_TO_PRICE_MAX,
        realized_to_modeled_ratio: 0.1,
      }),
      row({
        dist_id: "just-past",
        pack_price: 10,
        modeled_gross_ev: 10 * FOSSIL_EV_TO_PRICE_MAX + 0.01,
        realized_to_modeled_ratio: 0.1,
      }),
    ])
    expect(b.over.map((r) => r.dist_id)).toEqual(["on-the-line"])
  })

  it("⚠ `over` carries a HIGHER minimum modeled EV than `under`", () => {
    // A ratio is a ratio: on a pack modeled at $0.30 a realized $0.10 reads as a
    // dramatic over-valuation while being twenty cents. `over` is the accusatory
    // list — it says our own model was wrong — so it carries the higher bar.
    expect(OVER_MIN_MODELED_EV).toBeGreaterThan(UNDER_MIN_MODELED_EV)
    const b = bucketPackRealityRows([
      row({
        dist_id: "tiny-over",
        pack_price: 10,
        modeled_gross_ev: OVER_MIN_MODELED_EV - 0.01,
        realized_to_modeled_ratio: 0.1,
      }),
      row({
        dist_id: "tiny-under",
        pack_price: 10,
        modeled_gross_ev: UNDER_MIN_MODELED_EV,
        realized_to_modeled_ratio: 3,
      }),
    ])
    expect(b.over, "a trivially small pack is not evidence the model is wrong").toEqual([])
    expect(b.under.map((r) => r.dist_id), "the same size IS admitted to under").toEqual([
      "tiny-under",
    ])
  })

  it("⚠ `onModel` ranks by SAMPLE SIZE, not by ratio", () => {
    // A band has no "most" end to sort toward, so the most-opened distributions
    // lead as the strongest evidence the model is right. Sorting by ratio here
    // would rank by nothing meaningful.
    // ⚠ The ratios are INVERTED against the opens on purpose: the
    // most-opened row has the LOWER ratio. A first draft had them agreeing, and
    // the sort-by-ratio mutation survived because both orderings produced the
    // same list — the fixture has to make the two criteria DISAGREE.
    const b = bucketPackRealityRows([
      row({ dist_id: "few-opens", n_opens: 6, realized_to_modeled_ratio: 1.24 }),
      row({ dist_id: "many-opens", n_opens: 5000, realized_to_modeled_ratio: 0.85 }),
    ])
    expect(b.onModel.map((r) => r.dist_id)).toEqual(["many-opens", "few-opens"])
  })

  it("over ranks worst-first and under ranks most-extreme-first", () => {
    const b = bucketPackRealityRows([
      row({ dist_id: "over-mild", realized_to_modeled_ratio: 0.55 }),
      row({ dist_id: "over-worst", realized_to_modeled_ratio: 0.05 }),
      row({ dist_id: "under-mild", realized_to_modeled_ratio: 1.9 }),
      row({ dist_id: "under-wildest", realized_to_modeled_ratio: 9 }),
    ])
    expect(b.over.map((r) => r.dist_id)).toEqual(["over-worst", "over-mild"])
    expect(b.under.map((r) => r.dist_id)).toEqual(["under-wildest", "under-mild"])
  })
})

describe("bucketPackRealityRows — qualifying and caps", () => {
  it("drops rows with no price or no modeled EV from every bucket and from the count", () => {
    // Unlike the sibling market board, an unpriced row here is not merely
    // unrankable — the whole board is a comparison AGAINST the model, so a row
    // without one has nothing to compare and is not a qualifying observation.
    const b = bucketPackRealityRows([
      row({ dist_id: "ok", realized_to_modeled_ratio: 0.1 }),
      row({ dist_id: "no-price", pack_price: null, realized_to_modeled_ratio: 0.1 }),
      row({ dist_id: "zero-price", pack_price: 0, realized_to_modeled_ratio: 0.1 }),
      row({ dist_id: "empty-price", pack_price: "", realized_to_modeled_ratio: 0.1 }),
      row({ dist_id: "no-model", modeled_gross_ev: null, realized_to_modeled_ratio: 0.1 }),
      // ⚠ An unpriced row sitting INSIDE the on-model band. Without it, every
      // unpriced fixture had a ratio outside every band, so a bucket built from
      // the raw rows instead of `priced` was indistinguishable from a correct
      // one — the mutation survived until this row existed.
      row({ dist_id: "no-price-on-model", pack_price: null, realized_to_modeled_ratio: 1 }),
    ])
    expect(b.qualifying).toBe(1)
    expect(b.over.map((r) => r.dist_id)).toEqual(["ok"])
    expect(b.onModel, "an unpriced row cannot be evidence the model is RIGHT either").toEqual([])
  })

  it("caps each bucket at RANK_LIMIT and takes the TOP of the order, not the first N", () => {
    // ⚠ Supplied WORST-FIRST relative to the ranking, so a pre-sort slice picks
    // the wrong SET rather than merely the wrong order — the fixture shape a
    // sibling board's mutation needed before it would red.
    const rows = Array.from({ length: RANK_LIMIT + 4 }, (_, i) =>
      row({ dist_id: `o${i}`, realized_to_modeled_ratio: 0.59 - i * 0.01 }),
    )
    const b = bucketPackRealityRows(rows)
    expect(b.over).toHaveLength(RANK_LIMIT)
    expect(b.over[0].dist_id, "the most over-valued leads").toBe(`o${RANK_LIMIT + 3}`)
    expect(b.over.map((r) => r.dist_id)).not.toContain("o0")
  })

  it("an empty board is an honest empty answer", () => {
    expect(bucketPackRealityRows([])).toEqual({
      over: [],
      under: [],
      onModel: [],
      qualifying: 0,
    })
  })

  it("does not mutate the caller's array", () => {
    const rows = [
      row({ dist_id: "a", n_opens: 1, realized_to_modeled_ratio: 1 }),
      row({ dist_id: "b", n_opens: 99, realized_to_modeled_ratio: 1 }),
    ]
    bucketPackRealityRows(rows)
    expect(rows.map((r) => r.dist_id)).toEqual(["a", "b"])
  })
})

describe("fetchPackRealityBuckets", () => {
  afterEach(() => vi.restoreAllMocks())

  function dbReturning(result: { rows?: PackRealityRow[]; error?: unknown }) {
    const calls: Record<string, unknown> = {}
    const builder: Record<string, unknown> = {}
    for (const m of ["select", "gte", "eq", "gt", "not", "order", "range"]) {
      builder[m] = (...args: unknown[]) => {
        calls[m] = args
        return builder
      }
    }
    builder.then = (onF?: (v: unknown) => unknown) =>
      Promise.resolve({ data: result.rows ?? [], error: result.error ?? null }).then(onF)
    return {
      calls,
      db: {
        from: (view: string) => {
          calls.from = view
          return builder
        },
      },
    }
  }

  it("a FAILED read reports ok:false — this board's empty state is a REAL answer", () => {
    // ⚠ The distinction matters more here than on most boards: the view is
    // genuinely sparse until paid distributions clear the open threshold, so
    // "still gathering" is common and correct. If a failed read rendered the
    // same way, an outage would be invisible behind a legitimate empty state.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = dbReturning({ error: { message: "canceling statement due to statement timeout" } })
    return fetchPackRealityBuckets(db).then((b) => {
      expect(b.ok).toBe(false)
      expect(b).toMatchObject({ over: [], under: [], onModel: [], qualifying: 0 })
      expect(b.fetchedAt, "still stamped, so the page can say WHEN it failed").toBeTruthy()
    })
  })

  it("a SUCCESSFUL read with no rows is ok:true", async () => {
    const { db } = dbReturning({ rows: [] })
    const b = await fetchPackRealityBuckets(db)
    expect(b.ok).toBe(true)
    expect(b.qualifying).toBe(0)
  })

  it("applies every server-side gate, including the ones the JS filter repeats", async () => {
    // ⚠ The price/model filters exist in BOTH SQL and JS. The SQL copy is a cost
    // optimisation (this view aggregates 2.8M rows; the filter cut 1,559 rows to
    // 302, one page instead of two) and the JS copy is the correctness one — the
    // ranking must not depend on the SQL having been written right. Dropping
    // either is a real change, so both are pinned.
    const { calls, db } = dbReturning({ rows: [] })
    await fetchPackRealityBuckets(db)
    expect(calls.from).toBe("v_allday_pack_realized_ev")
    expect(calls.gte).toEqual(["n_opens", MIN_OPENS])
    expect(calls.eq, "stale-FMV distributions are excluded at the source").toEqual([
      "low_confidence_ev",
      false,
    ])
    expect(calls.gt).toEqual(["pack_price", 0])
    expect(calls.not).toEqual(["modeled_gross_ev", "is", null])
    expect(calls.order, "paging an unordered read can repeat or skip rows").toEqual([
      "dist_id",
      { ascending: true },
    ])
  })

  it("ranks the rows it fetched", async () => {
    const { db } = dbReturning({
      rows: [
        row({ dist_id: "over", realized_to_modeled_ratio: 0.2 }),
        row({ dist_id: "under", realized_to_modeled_ratio: 4 }),
      ],
    })
    const b = await fetchPackRealityBuckets(db)
    expect(b.ok).toBe(true)
    expect(b.over.map((r) => r.dist_id)).toEqual(["over"])
    expect(b.under.map((r) => r.dist_id)).toEqual(["under"])
  })
})
