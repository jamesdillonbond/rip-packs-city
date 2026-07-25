import { describe, it, expect } from "vitest"
import {
  formatUsd,
  formatPrice,
  formatNumber,
  relativeFromNow,
  truncateAddr,
  isLinkableAddr,
  COLLECTION_LABEL,
  summarizeKind,
  isAnonymousSale,
  activityRowKey,
  reshapeHourly,
  KIND_FILTERS,
  kindsForFilter,
} from "@/lib/analytics-pulse-dashboard-compute"
import type { PulseActivityRow, PulseHourlyRow } from "@/lib/analytics-types"

// Pins the pure formatting / bucketing / dedupe / summarization logic lifted
// out of components/analytics/PulseDashboard.tsx (invisible to the coverage
// ratchet). A regression here mis-formats the live activity feed or its KPIs.

function actRow(overrides: Partial<PulseActivityRow> = {}): PulseActivityRow {
  return {
    occurred_at: "2026-07-24T12:00:00.000Z",
    kind: "sale",
    collection: "topshot",
    primary_addr: null,
    counterparty: null,
    amount_usd: 100,
    details: {},
    ...overrides,
  }
}

describe("formatUsd", () => {
  it("returns $0 for null/undefined/non-finite/non-positive", () => {
    expect(formatUsd(null)).toBe("$0")
    expect(formatUsd(undefined)).toBe("$0")
    expect(formatUsd(NaN)).toBe("$0")
    expect(formatUsd(Infinity)).toBe("$0")
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(-5)).toBe("$0")
  })
  it("formats millions with M suffix", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00M")
    expect(formatUsd(2_540_000)).toBe("$2.54M")
  })
  it("formats thousands with k suffix", () => {
    expect(formatUsd(1_000)).toBe("$1.0k")
    expect(formatUsd(12_340)).toBe("$12.3k")
  })
  it("formats sub-thousand as whole dollars", () => {
    expect(formatUsd(999)).toBe("$999")
    expect(formatUsd(12.7)).toBe("$13")
  })
})

describe("formatPrice", () => {
  it("returns em-dash for null/undefined/non-finite", () => {
    expect(formatPrice(null)).toBe("—")
    expect(formatPrice(undefined)).toBe("—")
    expect(formatPrice(NaN)).toBe("—")
  })
  it("formats >=10k with k suffix", () => {
    expect(formatPrice(10_000)).toBe("$10.0k")
    expect(formatPrice(15_500)).toBe("$15.5k")
  })
  it("formats >=100 and <10k as whole dollars", () => {
    expect(formatPrice(100)).toBe("$100")
    expect(formatPrice(9_999)).toBe("$9999")
  })
  it("formats <100 with two decimals (incl. zero/negative)", () => {
    expect(formatPrice(99.9)).toBe("$99.90")
    expect(formatPrice(0)).toBe("$0.00")
    expect(formatPrice(-3)).toBe("$-3.00")
  })
})

describe("formatNumber", () => {
  it("returns 0 for null/undefined/non-finite/non-positive", () => {
    expect(formatNumber(null)).toBe("0")
    expect(formatNumber(undefined)).toBe("0")
    expect(formatNumber(NaN)).toBe("0")
    expect(formatNumber(0)).toBe("0")
    expect(formatNumber(-2)).toBe("0")
  })
  it("formats millions and thousands", () => {
    expect(formatNumber(1_000_000)).toBe("1.00M")
    expect(formatNumber(3_400)).toBe("3.4k")
  })
  it("formats small integers verbatim", () => {
    expect(formatNumber(42)).toBe("42")
    expect(formatNumber(999)).toBe("999")
  })
})

describe("relativeFromNow", () => {
  const now = Date.parse("2026-07-24T12:00:00.000Z")
  it("returns em-dash for missing / unparseable iso", () => {
    expect(relativeFromNow(null, now)).toBe("—")
    expect(relativeFromNow(undefined, now)).toBe("—")
    expect(relativeFromNow("not-a-date", now)).toBe("—")
  })
  it("returns 'just now' for future or <5s", () => {
    expect(relativeFromNow("2026-07-24T12:00:10.000Z", now)).toBe("just now") // future
    expect(relativeFromNow("2026-07-24T11:59:57.000Z", now)).toBe("just now") // 3s ago
  })
  it("formats seconds / minutes / hours / days", () => {
    expect(relativeFromNow("2026-07-24T11:59:30.000Z", now)).toBe("30s ago")
    expect(relativeFromNow("2026-07-24T11:45:00.000Z", now)).toBe("15m ago")
    expect(relativeFromNow("2026-07-24T09:00:00.000Z", now)).toBe("3h ago")
    expect(relativeFromNow("2026-07-22T12:00:00.000Z", now)).toBe("2d ago")
  })
  it("falls back to a locale date for >=30d", () => {
    const iso = "2026-01-01T12:00:00.000Z"
    expect(relativeFromNow(iso, now)).toBe(new Date(iso).toLocaleDateString())
  })
  it("defaults now to Date.now() when omitted", () => {
    // A far-past timestamp is always in the >=30d branch regardless of clock.
    const iso = "2000-01-01T00:00:00.000Z"
    expect(relativeFromNow(iso)).toBe(new Date(iso).toLocaleDateString())
  })
})

describe("truncateAddr", () => {
  it("returns empty string for falsy input", () => {
    expect(truncateAddr(null)).toBe("")
    expect(truncateAddr(undefined)).toBe("")
    expect(truncateAddr("")).toBe("")
  })
  it("lowercases and passes through short / non-0x values", () => {
    expect(truncateAddr("ABC")).toBe("abc")
    expect(truncateAddr("0x1234")).toBe("0x1234") // <=10 chars
  })
  it("truncates a full 0x address", () => {
    expect(truncateAddr("0xBD94CADE097E50AC")).toBe("0xbd94…50ac")
  })
})

describe("isLinkableAddr", () => {
  it("accepts a 16-hex 0x address (case-insensitive)", () => {
    expect(isLinkableAddr("0xbd94cade097e50ac")).toBe(true)
    expect(isLinkableAddr("0xBD94CADE097E50AC")).toBe(true)
  })
  it("rejects nullish / short / non-hex", () => {
    expect(isLinkableAddr(null)).toBe(false)
    expect(isLinkableAddr(undefined)).toBe(false)
    expect(isLinkableAddr("0x1234")).toBe(false)
    expect(isLinkableAddr("0xzzzzcade097e50ac")).toBe(false)
  })
})

describe("summarizeKind", () => {
  it("loan_originated with apr + term", () => {
    const s = summarizeKind(
      actRow({ kind: "loan_originated", amount_usd: 1200, collection: "allday", details: { term_days: 30, apr_pct: 12.4 } }),
    )
    expect(s).toBe("Loan originated: $1.2k for 30d at 12% APR · All Day")
  })
  it("loan_originated without apr falls back to term-only tail and em-dash term", () => {
    const s = summarizeKind(actRow({ kind: "loan_originated", amount_usd: 50, collection: "golazos", details: {} }))
    expect(s).toBe("Loan originated: $50 for — · Golazos")
  })
  it("loan_repaid with and without principal", () => {
    expect(
      summarizeKind(actRow({ kind: "loan_repaid", amount_usd: 500, collection: "ufc", details: { principal_usd: 450 } })),
    ).toBe("Loan repaid: $500 (principal $450) · UFC")
    expect(
      summarizeKind(actRow({ kind: "loan_repaid", amount_usd: 500, collection: "ufc", details: {} })),
    ).toBe("Loan repaid: $500 · UFC")
  })
  it("loan_settled uses principal when present, else amount", () => {
    expect(
      summarizeKind(actRow({ kind: "loan_settled", amount_usd: 700, collection: "pinnacle", details: { principal_usd: 650 } })),
    ).toBe("Loan defaulted: $650 settled to lender · Pinnacle")
    expect(
      summarizeKind(actRow({ kind: "loan_settled", amount_usd: 700, collection: "pinnacle", details: {} })),
    ).toBe("Loan defaulted: $700 settled to lender · Pinnacle")
  })
  it("sale with serial and with default marketplace label", () => {
    expect(
      summarizeKind(actRow({ kind: "sale", amount_usd: 250, collection: "topshot", details: { marketplace: "Flowty", serial_number: 7 } })),
    ).toBe("Sale: $250 on flowty · #7 · Top Shot")
    expect(
      summarizeKind(actRow({ kind: "sale", amount_usd: 250, collection: "topshot", details: {} })),
    ).toBe("Sale: $250 on marketplace · Top Shot")
  })
  it("unknown collection passes through raw; details null tolerated", () => {
    const s = summarizeKind(actRow({ kind: "sale", amount_usd: 10, collection: "wnba", details: null as unknown as Record<string, unknown> }))
    expect(s).toBe("Sale: $10 on marketplace · wnba")
  })
  it("unknown kind returns collection label", () => {
    const s = summarizeKind(actRow({ kind: "mystery" as PulseActivityRow["kind"], collection: "allday" }))
    expect(s).toBe("All Day")
  })
})

describe("isAnonymousSale", () => {
  it("false for non-sale kinds", () => {
    expect(isAnonymousSale(actRow({ kind: "loan_originated" }))).toBe(false)
  })
  it("true when marketplace is topshot", () => {
    expect(isAnonymousSale(actRow({ kind: "sale", details: { marketplace: "TopShot" }, primary_addr: "0xabc" }))).toBe(true)
  })
  it("true when both wallets missing on a non-topshot sale", () => {
    expect(isAnonymousSale(actRow({ kind: "sale", details: { marketplace: "flowty" }, primary_addr: null, counterparty: null }))).toBe(true)
  })
  it("false when a counterparty exists on a non-topshot sale", () => {
    expect(isAnonymousSale(actRow({ kind: "sale", details: { marketplace: "flowty" }, primary_addr: null, counterparty: "0xdef" }))).toBe(false)
  })
})

describe("activityRowKey", () => {
  it("prefers tx_hash", () => {
    expect(activityRowKey(actRow({ details: { tx_hash: "0xtx" } }))).toBe("0xtx")
  })
  it("falls back to listing_resource_id", () => {
    expect(activityRowKey(actRow({ details: { listing_resource_id: 987 } }))).toBe("987")
  })
  it("falls back to composite occurred/kind/addr (anon when no addr)", () => {
    expect(
      activityRowKey(actRow({ occurred_at: "T1", kind: "sale", primary_addr: null, details: {} })),
    ).toBe("T1-sale-anon")
    expect(
      activityRowKey(actRow({ occurred_at: "T1", kind: "sale", primary_addr: "0xabc", details: {} })),
    ).toBe("T1-sale-0xabc")
  })
  it("tolerates null details", () => {
    expect(
      activityRowKey(actRow({ occurred_at: "T2", kind: "loan_repaid", primary_addr: null, details: null as unknown as Record<string, unknown> })),
    ).toBe("T2-loan_repaid-anon")
  })
})

describe("reshapeHourly", () => {
  const rows: PulseHourlyRow[] = [
    { hour: "2026-07-24T13:00:00.000Z", loan_count: 2, loan_volume_usd: 0, sale_count: 5, sale_volume_usd: 0 },
    { hour: "2026-07-24T11:00:00.000Z", loan_count: 1, loan_volume_usd: 0, sale_count: 3, sale_volume_usd: 0 },
  ]
  it("sorts ascending by hour and labels in UTC HH:00", () => {
    const out = reshapeHourly(rows)
    expect(out.map((p) => p.hourLabel)).toEqual(["11:00", "13:00"])
    expect(out[0]).toMatchObject({ loan_count: 1, sale_count: 3 })
    expect(out[1]).toMatchObject({ loan_count: 2, sale_count: 5 })
  })
  it("coerces non-numeric counts to 0", () => {
    const out = reshapeHourly([
      { hour: "2026-07-24T10:00:00.000Z", loan_count: NaN as unknown as number, loan_volume_usd: 0, sale_count: undefined as unknown as number, sale_volume_usd: 0 },
    ])
    expect(out[0]).toMatchObject({ loan_count: 0, sale_count: 0 })
  })
  it("falls back to slicing the raw string on an unparseable hour", () => {
    // First 11 chars mimic the ISO "YYYY-MM-DDT" prefix so slice(11,16) yields
    // the (non-numeric, therefore Date-unparseable) time segment "XX:YY".
    const out = reshapeHourly([
      { hour: "0000-00-00TXX:YY", loan_count: 0, loan_volume_usd: 0, sale_count: 0, sale_volume_usd: 0 },
    ])
    expect(out[0].hourLabel).toBe("XX:YY")
  })
  it("does not mutate the input array order", () => {
    const input = rows.slice()
    reshapeHourly(input)
    expect(input[0].hour).toBe("2026-07-24T13:00:00.000Z")
  })
})

describe("COLLECTION_LABEL / KIND_FILTERS / kindsForFilter", () => {
  it("maps known collection slugs", () => {
    expect(COLLECTION_LABEL.topshot).toBe("Top Shot")
    expect(COLLECTION_LABEL.ufc).toBe("UFC")
  })
  it("KIND_FILTERS has the three filter keys", () => {
    expect(KIND_FILTERS.map((k) => k.key)).toEqual(["all", "loans", "sales"])
  })
  it("kindsForFilter resolves each key", () => {
    expect(kindsForFilter("all")).toBeNull()
    expect(kindsForFilter("loans")).toEqual(["loan_originated", "loan_repaid", "loan_settled"])
    expect(kindsForFilter("sales")).toEqual(["sale"])
  })
})
