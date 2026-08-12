// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import DealsBoardClient, { type Row } from "@/app/insights/deals/DealsBoardClient"

// The fee-net column on the public /insights/deals board, plus the KPI median.
//
// This column exists to catch the case the gross discount hides: a listing that
// looks underpriced until the marketplace's seller fee is taken out. The repo
// has already been bitten once here — deep-audit D9 found NetOfFeesNote using
// `flipsNegative` as a SIGN flag, printing "net +$0.25" on a row where the buyer
// LOSES $0.25, on roughly 199 of 200 rows, with a passing test written against
// an impossible fixture. So the assertions below are about the SIGN and the
// FLAG, not about whether the cell renders.
//
// The pairing that matters: `flipsNegative` (the gross discount does not survive
// fees) and a negative net margin are related but not identical, and the cell
// styles/flags on both. A row can clear fees and still be a thin, honest win;
// a row can show a fat gross discount and be a loss. Both are pinned.

const base: Row = {
  external_id: "141:5156",
  name: "Victor Wembanyama",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 2999,
  fmv_usd: 200,
  confidence: "HIGH",
  low_confidence_fmv: false,
  low_ask: 150,
  discount_pct: 25,
  discount_usd: 50,
  ask_updated_at: new Date(Date.now() - 3600_000).toISOString(),
  collection_slug: "nba-top-shot",
  collection_name: "NBA Top Shot",
  render_id: null,
  detail_url: "/nba-top-shot/edition/x",
  thumbnail_url: "https://example.com/a.png",
}
const row = (o: Partial<Row> = {}): Row => ({ ...base, ...o })

function mount(rows: Row[]) {
  return render(
    <DealsBoardClient initialRows={rows} initialFetchedAt="2026-08-02T00:00:00Z" />
  )
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
        }) as Response
    )
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the fee-net cell reports the SIGN of the outcome, not just its size", () => {
  it("marks a comfortable discount as a positive net", () => {
    // Ask 150 against FMV 200 clears the Top Shot seller fee with room to spare.
    const { container } = mount([row({ low_ask: 150, fmv_usd: 200, discount_pct: 25 })])
    expect(container.querySelector(".rpc-dl-net-pos")).toBeTruthy()
    expect(container.querySelector(".rpc-dl-net-neg")).toBeNull()
    expect(container.textContent).not.toContain("fees erase this discount")
  })

  it("marks a discount that fees erase as NEGATIVE and says so in words", () => {
    // A ~2% gross discount does not survive a percentage seller fee. This is the
    // exact shape D9 rendered as a gain.
    const { container } = mount([row({ low_ask: 196, fmv_usd: 200, discount_pct: 2 })])
    expect(container.querySelector(".rpc-dl-net-neg")).toBeTruthy()
    expect(container.querySelector(".rpc-dl-net-pos")).toBeNull()
    expect(container.textContent).toContain("fees erase this discount")
    // The margin must carry a minus, not a plus with a smaller number.
    const cell = container.querySelector(".rpc-dl-net-neg")
    expect(cell?.textContent).toContain("−")
    expect(cell?.textContent).not.toContain("+")
  })

  it("reports a LOSS as a loss even when flipsNegative is false — the D9 shape", () => {
    // The load-bearing case, and the one a naive fixture misses. flipsNegative is
    // `fmv > ask && netMargin <= 0`, so it is FALSE whenever there is no gross
    // discount at all — including an ask that exactly equals FMV, where the fee
    // still makes the round trip a loss. Using flipsNegative as the SIGN (which
    // is precisely what D9 did) renders "+$10" on a $10 loss here, and no fixture
    // with a gross discount can catch it, because there the two agree.
    const { container } = mount([row({ low_ask: 200, fmv_usd: 200, discount_pct: 0 })])
    const cell = container.querySelector(".rpc-dl-net-neg")
    expect(cell, "a negative net margin must style as negative").toBeTruthy()
    expect(cell?.textContent).toContain("−")
    expect(cell?.textContent).not.toContain("+")
    // ...and it must NOT claim fees erased a discount, because there wasn't one.
    expect(container.textContent).not.toContain("fees erase this discount")
  })

  it("applies Pinnacle's higher rate and its $0.50 floor", () => {
    // Pinnacle charges 7.5% plus a $0.50 completed-sale floor. On a $1 pin — the
    // board's real minimum ask — that floor is a 50% haircut, so a gross
    // "discount" there is not a deal. Wiring the Top Shot 5% rate for every
    // collection would render this row as a win.
    const { container } = mount([
      row({ collection_slug: "disney-pinnacle", low_ask: 1, fmv_usd: 1.4, discount_pct: 29 }),
    ])
    const cell = container.querySelector(".rpc-dl-net-neg")
    expect(cell).toBeTruthy()
    expect(cell?.getAttribute("title")).toMatch(/7\.5% goes to Disney Pinnacle/)
    expect(cell?.getAttribute("title")).toMatch(/minimum \$0\.50/)
  })

  it("renders an em-dash rather than a fabricated net when the inputs are missing", () => {
    // No ask and no FMV means no computable net. Printing $0.00 or a 0% margin
    // here would read as "breaks even", a claim the data does not support.
    const { container } = mount([row({ low_ask: null, fmv_usd: null, discount_pct: null })])
    const none = container.querySelector(".rpc-dl-net-none")
    expect(none).toBeTruthy()
    expect(none?.textContent).toBe("—")
    expect(container.textContent).not.toContain("$NaN")
  })

  it("explains the fee in the cell's title so the number is auditable", () => {
    const { container } = mount([row({ low_ask: 150, fmv_usd: 200 })])
    const title = container.querySelector(".rpc-dl-net-pos")?.getAttribute("title") ?? ""
    // Names the rate, the recipient, and both sides of the comparison.
    expect(title).toMatch(/goes to/)
    expect(title).toMatch(/You keep \$/)
    // fmtUsd drops the decimals at >= $100, so the ask reads "$150", not
    // "$150.00" — the title is built from the same ladder as the table cells.
    expect(title).toMatch(/against a \$150 ask/)
  })

  it("never emits NaN or Infinity for a zero ask", () => {
    // netMarginPct divides by the ask; a 0 ask would produce Infinity.
    const { container } = mount([row({ low_ask: 0, fmv_usd: 200, discount_pct: 100 })])
    const t = container.textContent ?? ""
    expect(t).not.toMatch(/NaN|Infinity/)
  })
})

describe("the KPI median is a real median", () => {
  // ⚠ These assert on the KPI NODE, not on document text. Every row also renders
  // its own discount, and on an odd-sized set the median IS one of those values,
  // so a whole-document `toContain` passes no matter which element produced it —
  // it cannot tell the KPI from a table cell.
  const kpiValues = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(".rpc-dl-kpi-value")).map((n) => n.textContent)

  it("averages the two middles on an EVEN-sized set", () => {
    // discounts 11, 13, 41, 43 -> 27. A midpoint pick reports 41, overstating the
    // board's typical discount on a headline number. 27 appears on no row, so the
    // assertion cannot be satisfied by a table cell.
    const { container } = mount([
      row({ external_id: "a", discount_pct: 11 }),
      row({ external_id: "b", discount_pct: 13 }),
      row({ external_id: "c", discount_pct: 41 }),
      row({ external_id: "d", discount_pct: 43 }),
    ])
    expect(kpiValues(container)).toContain("27%")
  })

  it("takes the middle on an ODD-sized set", () => {
    const { container } = mount([
      row({ external_id: "a", discount_pct: 10 }),
      row({ external_id: "b", discount_pct: 31 }),
      row({ external_id: "c", discount_pct: 90 }),
    ])
    expect(kpiValues(container)).toContain("31%")
  })

  it("counts only rows at or above the 25% threshold as big discounts", () => {
    // Boundary matters: 25 is included, 24 is not.
    const { container } = mount([
      row({ external_id: "a", discount_pct: 24 }),
      row({ external_id: "b", discount_pct: 25 }),
      row({ external_id: "c", discount_pct: 60 }),
    ])
    // Two of three qualify; the count is rendered as its own KPI value.
    const values = Array.from(container.querySelectorAll(".rpc-dl-kpi-value")).map((n) => n.textContent)
    expect(values).toContain("2")
  })

  it("treats a null discount as 0 rather than dropping the row from the count", () => {
    const { container } = mount([
      row({ external_id: "a", discount_pct: null }),
      row({ external_id: "b", discount_pct: 40 }),
    ])
    const values = Array.from(container.querySelectorAll(".rpc-dl-kpi-value")).map((n) => n.textContent)
    // Row count is 2 — the null-discount row is still a listed edition.
    expect(values).toContain("2")
  })
})
