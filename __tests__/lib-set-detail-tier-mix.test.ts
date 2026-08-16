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
