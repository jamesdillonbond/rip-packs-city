import { describe, it, expect } from "vitest"
import {
  normalizeFlowAddress,
  formatPackReportText,
} from "@/lib/alerts/soldpacks"
import type { PackReport } from "@/lib/alerts/soldpacks"

// normalizeFlowAddress guards every wallet arg coming off the Telegram/Discord
// bot; formatPackReportText renders the pack P/L digest. Pin both.

describe("normalizeFlowAddress", () => {
  it("lower-cases, adds the 0x prefix, and validates the 16-hex shape", () => {
    expect(normalizeFlowAddress("BD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normalizeFlowAddress("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normalizeFlowAddress("  bd94cade097e50ac  ")).toBe("0xbd94cade097e50ac")
  })

  it("returns null for the wrong length or non-hex", () => {
    expect(normalizeFlowAddress("0x123")).toBeNull()
    expect(normalizeFlowAddress("not-an-address")).toBeNull()
    expect(normalizeFlowAddress("0xZZ94cade097e50ac")).toBeNull()
    expect(normalizeFlowAddress("")).toBeNull()
  })
})

describe("formatPackReportText", () => {
  const wallet = "0xbd94cade097e50ac"

  it("reports no history when totals are null or all-zero", () => {
    const empty: PackReport = { wallet, totals: null, recent: [] }
    expect(formatPackReportText(empty)).toContain("No pack history found")
  })

  it("renders the totals digest + recent lines + footer", () => {
    const report: PackReport = {
      wallet,
      totals: {
        packs_purchased: 5,
        packs_ripped: 3,
        packs_sold: 1,
        primary_drops: 2,
        secondary_buys: 3,
        spent_usd: 120,
        sold_proceeds_usd: 40,
        ripped_value_usd: 95,
        net_pl_usd: 15,
      },
      recent: [
        {
          pack_name: "Base Set Pack",
          status: "sold",
          buy_price: 10,
          sell_price: 25,
          pull_value_usd: null,
          realized_pl_usd: 15,
          collection_name: "NBA Top Shot",
        },
        {
          pack_name: "Quick Rips",
          status: "ripped",
          buy_price: 5,
          sell_price: null,
          pull_value_usd: 8,
          realized_pl_usd: null,
          collection_name: "NBA Top Shot",
        },
      ],
    }
    const text = formatPackReportText(report)
    expect(text).toContain("Pack report for")
    expect(text).toContain("Purchased: 5")
    expect(text).toContain("Recent packs:")
    expect(text).toContain("Base Set Pack")
    expect(text).toContain("Quick Rips")
    expect(text).toContain("rippackscity.com/dashboard/history")
  })
})
