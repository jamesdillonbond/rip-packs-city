import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchFullTierMix,
  buildTierMixRows,
  PAGE,
  type TierCount,
} from "@/lib/set-detail/tier-mix"

// The full-set tier mix behind /[collection]/set/[slug].
//
// ⚠ THIS LOGIC WAS UNREACHABLE UNTIL IT WAS EXTRACTED, and it carried a live
// defect: the fetcher returned a bare [] on a query ERROR, which the page read
// as its documented "no full-set count available, sample the first page"
// fallback. The bar renders ABSOLUTE COUNTS, so a failed read on a
// ~3,600-edition set published "COMMON · 62 · 62.0%" against a true ~2,200 — in
// the same type and colour as the accurate bar, with nothing on screen to
// distinguish them.

function pageOf(n: number, tier: string): Array<{ tier: string | null }> {
  return Array.from({ length: n }, () => ({ tier }))
}

/** A db stub returning a scripted sequence of `.range()` results. */
function dbReturning(results: Array<{ data?: unknown; error?: { message: string } }>) {
  const calls: { table?: string; ranges: Array<[number, number]>; in?: [string, unknown] } = {
    ranges: [],
  }
  let i = 0
  const builder: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "not", "order"]) {
    builder[m] = (...args: unknown[]) => {
      if (m === "in") calls.in = [args[0] as string, args[1]]
      return builder
    }
  }
  builder.range = (from: number, to: number) => {
    calls.ranges.push([from, to])
    const r = results[Math.min(i, results.length - 1)]
    i++
    return Promise.resolve({ data: r.data ?? [], error: r.error ?? null })
  }
  return {
    calls,
    db: {
      from: (table: string) => {
        calls.table = table
        return builder
      },
    },
  }
}

describe("fetchFullTierMix", () => {
  afterEach(() => vi.restoreAllMocks())

  it("a FAILED read reports ok:false — never an empty mix", async () => {
    // ⚠ THE DEFECT THIS MODULE EXISTS TO FIX. `ok` is the only thing separating
    // "we could not count the set" from "this set has no countable editions",
    // and the caller renders the two completely differently: the first withholds
    // the bar, the second samples the first page. Collapsing them republishes a
    // 100-edition sample as a full-set measurement.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = dbReturning([{ error: { message: "canceling statement due to statement timeout" } }])
    const r = await fetchFullTierMix("coll", ["Base Set"], db)
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it("DISCARDS partial counts when a LATER page fails", async () => {
    // ⚠ A truncated mix is not a smaller answer, it is a WRONG one: the
    // percentages are computed over whatever survived and still sum to 100, so
    // a half-read set renders as a complete and confident bar. Returning the
    // first page's counts with ok:false would be worse than returning nothing,
    // because a future caller could reasonably decide to render "partial" data.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { db } = dbReturning([
      { data: pageOf(PAGE, "COMMON") },
      { error: { message: "boom" } },
    ])
    const r = await fetchFullTierMix("coll", ["Base Set"], db)
    expect(r.ok).toBe(false)
    expect(r.rows, "no partial counts leak out").toEqual([])
  })

  it("a SUCCESSFUL read with no rows is ok:true — the sample fallback is correct there", async () => {
    const { db } = dbReturning([{ data: [] }])
    const r = await fetchFullTierMix("coll", ["Base Set"], db)
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([])
  })

  it("no set names is ok:true, and does not query at all", async () => {
    // Asking about no sets is not a failed read. Reporting it as one would hide
    // the bar on a detail row that carries no set name.
    const { calls, db } = dbReturning([{ data: pageOf(3, "RARE") }])
    const r = await fetchFullTierMix("coll", [null as unknown as string, ""], db)
    expect(r).toEqual({ rows: [], ok: true })
    expect(calls.ranges, "no query issued").toEqual([])
  })

  it("PAGES past PostgREST's 1,000-row cap and stops on a short page", async () => {
    // ⚠ The reason paging exists at all: "Base Set" (~3,600 thumbnail-bearing
    // editions) exceeds the cap, so a single read undercounts it — the exact
    // sampling error the module's honesty guarantee is about, arriving through
    // a successful read instead of a failed one.
    const { calls, db } = dbReturning([
      { data: pageOf(PAGE, "COMMON") },
      { data: pageOf(PAGE, "RARE") },
      { data: pageOf(7, "LEGENDARY") },
    ])
    const r = await fetchFullTierMix("coll", ["Base Set"], db)
    expect(r.ok).toBe(true)
    expect(calls.ranges).toEqual([
      [0, PAGE - 1],
      [PAGE, PAGE * 2 - 1],
      [PAGE * 2, PAGE * 3 - 1],
    ])
    expect(new Map(r.rows.map((x) => [x.tier, x.n]))).toEqual(
      new Map([
        ["COMMON", PAGE],
        ["RARE", PAGE],
        ["LEGENDARY", 7],
      ]),
    )
  })

  it("dedupes the set-name variants it queries", async () => {
    // The caller passes detail.set_name plus its variants, which routinely
    // repeat the primary spelling.
    const { calls, db } = dbReturning([{ data: [] }])
    await fetchFullTierMix("coll", ["Base Set", "Base Set", "Base  Set"], db)
    expect(calls.in).toEqual(["set_name", ["Base Set", "Base  Set"]])
  })

  it("counts a NULL tier as UNKNOWN rather than dropping the edition", async () => {
    // Dropping it would make the percentages describe a smaller set than the
    // one named on the page, and the EDITIONS stat above the bar would no
    // longer reconcile with it.
    const { db } = dbReturning([{ data: [{ tier: null }, { tier: "rare" }, { tier: "RARE" }] }])
    const r = await fetchFullTierMix("coll", ["S"], db)
    expect(new Map(r.rows.map((x) => [x.tier, x.n]))).toEqual(
      new Map([
        ["UNKNOWN", 1],
        // ⚠ case-folded, so a lowercase upstream tier does not render as a
        // second slice of the same colour.
        ["RARE", 2],
      ]),
    )
  })

  it("reads thumbnail-bearing editions of the right collection only", async () => {
    // The scope has to match get_set_editions / get_set_detail or the mix stops
    // reconciling with the EDITIONS stat: ~6.4k inert UUID-fossil Top Shot
    // editions carry no thumbnail and inflated "Holo Icon" 350 -> 608.
    const { calls, db } = dbReturning([{ data: [] }])
    await fetchFullTierMix("coll", ["S"], db)
    expect(calls.table).toBe("editions")
  })
})

describe("buildTierMixRows", () => {
  const full: TierCount[] = [
    { tier: "RARE", n: 25 },
    { tier: "COMMON", n: 75 },
  ]

  it("orders slices largest-first and derives pct from the FULL total", () => {
    const rows = buildTierMixRows(full, [])
    expect(rows.map((r) => r.tier)).toEqual(["COMMON", "RARE"])
    expect(rows.map((r) => r.pct)).toEqual([75, 25])
  })

  it("IGNORES the sample whenever the full-set count has rows", () => {
    // ⚠ Guards the direction that matters: the sample is capped at the first
    // page, so preferring it over a real full-set count is precisely the
    // undercount the module exists to prevent.
    const rows = buildTierMixRows(full, Array.from({ length: 100 }, () => ({ tier: "LEGENDARY" })))
    expect(rows.map((r) => r.tier)).not.toContain("LEGENDARY")
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(100)
  })

  it("falls back to the first-page sample when the full count is legitimately empty", () => {
    const rows = buildTierMixRows([], [{ tier: "rare" }, { tier: "RARE" }, { tier: null }])
    expect(rows).toEqual([
      { tier: "RARE", n: 2, pct: (2 / 3) * 100 },
      { tier: "UNKNOWN", n: 1, pct: (1 / 3) * 100 },
    ])
  })

  it("no data at all yields no rows rather than a divide-by-zero", () => {
    // The page hides the section on an empty array; a NaN pct would render a
    // zero-width bar with "NaN%" beside it.
    expect(buildTierMixRows([], [])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOUND — the sweep gets ONE deadline, not one per page.
//
// ⚠ The arithmetic is the whole point. The loop runs up to `MAX_ROWS / PAGE` =
// 60 iterations, so a per-page budget of even 5s would bound this read at five
// MINUTES — a ceiling far above the ~30s a document has, which is no bound at
// all. A shared deadline is what the caller actually needs, and these assertions
// pin it: a sweep whose FIRST page is slow must fail, and so must one whose
// LATER page is slow after earlier pages already spent the budget.
//
// ⚠ Both land in the existing discard-the-partials branch, for the reason the
// module already states: a truncated mix is not a smaller answer, it is a WRONG
// one — the percentages would still sum to 100 and read as complete. Running out
// of budget mid-sweep is exactly where the temptation to keep the partial counts
// is strongest.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A db whose `.range()` resolves normally for the first `fastPages` calls and
 * then never settles.
 */
function dbHangingAfter(fastPages: number) {
  let i = 0
  const builder: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "not", "order"]) builder[m] = () => builder
  builder.range = () => {
    const n = i++
    if (n < fastPages) return Promise.resolve({ data: pageOf(PAGE, "COMMON"), error: null })
    return new Promise(() => {})
  }
  return { from: () => builder }
}

/**
 * A db whose every page takes `perPageMs`, returning FULL pages so the loop
 * keeps going, and a short page at `endAfter` so a sweep that survives can end.
 *
 * ⚠ THE DELAY IS THE POINT. An earlier draft of the shared-deadline test used
 * INSTANT pages and a hang on the third — and a mutation to a per-page budget
 * PASSED it, because instant pages spend none of the budget and the third page
 * times out either way. That is the vacuous-assertion shape this repo keeps
 * recording: the comment stated "the deadline is shared" while the assertion
 * tested something weaker. Only pages that actually CONSUME the budget can tell
 * the two designs apart.
 */
function dbSlowPages(perPageMs: number, endAfter: number) {
  let i = 0
  const builder: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "not", "order"]) builder[m] = () => builder
  builder.range = () => {
    const n = i++
    return new Promise((resolve) =>
      setTimeout(
        () => resolve({ data: pageOf(n >= endAfter ? 1 : PAGE, "COMMON"), error: null }),
        perPageMs,
      ),
    )
  }
  return { from: () => builder }
}

describe("fetchFullTierMix — the sweep is bounded as a whole", () => {
  it("a first page that hangs reports ok:false, not a partial mix", async () => {
    const res = await fetchFullTierMix("c1", ["Set A"], dbHangingAfter(0))

    expect(res.ok, "an overrun sweep must report FAILURE").toBe(false)
    expect(res.rows).toEqual([])
    // ⚠ The absence of the false claim: rows with ok:true is a COMPLETE mix.
    expect(res.rows.length > 0 && res.ok === true).toBe(false)
  }, 20_000)

  it("pages that SPEND the budget exhaust it — the deadline is shared, not per page", async () => {
    // ⚠ MUTATION-CHECKED IN BOTH DIRECTIONS. With the 6s budget shared, pages of
    // 2.5s each mean page 3 gets ~1s and is cut, so the sweep fails and the
    // counts already gathered are discarded. Swap the shared deadline for a
    // per-page `TIER_MIX_TIMEOUT_MS` and every page gets a fresh 6s, the sweep
    // finishes in ~10s, and this assertion reds — which is the whole property.
    const res = await fetchFullTierMix("c1", ["Set A"], dbSlowPages(2_500, 3))

    expect(res.ok, "a sweep that ran past its shared deadline must FAIL").toBe(false)
    expect(res.rows, "partial counts must be discarded, not published as the mix").toEqual([])
  }, 30_000)

  it("CONTROL — a sweep inside the budget still returns its counts", async () => {
    // Without this, a bound that failed unconditionally would satisfy both
    // assertions above while the function had stopped working.
    const { db } = dbReturning([{ data: pageOf(3, "RARE") }])
    const res = await fetchFullTierMix("c1", ["Set A"], db)

    expect(res.ok).toBe(true)
    expect(res.rows).toEqual([{ tier: "RARE", n: 3 }])
  })
})
