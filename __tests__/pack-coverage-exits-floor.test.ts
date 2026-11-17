import { describe, it, expect } from "vitest"
import { packCoverage } from "@/lib/packs-wallet-view-format"

// 2026-10-18: packs that LEFT the wallet (ripped or sold) were acquired somehow,
// so they floor the spend denominator. Before, a wallet with no buy rows had
// nothing to cost and Net P&L published the gross rip value as profit.
describe("packCoverage — exits floor the spend denominator", () => {
  it("withholds P&L for a wallet with rips and no buy rows (0xd708…, Pinnacle)", () => {
    const t = { packs_purchased: 0, packs_ripped: 2651, ripped_value_known_count: 2651, packs_sold: 0, primary_spend_unknown_count: 0, inferred_primary_count: 0 }
    expect(packCoverage(t).plWithheld).toBe(true)
  })

  it("counts sold packs as exits too", () => {
    const t = { packs_purchased: 10, packs_ripped: 0, ripped_value_known_count: 0, packs_sold: 100, primary_spend_unknown_count: 0 }
    expect(packCoverage(t).plWithheld).toBe(true)
  })

  it("NO-CHANGE CONTROL: a fully costed wallet still publishes", () => {
    const t = { packs_purchased: 50, packs_ripped: 40, ripped_value_known_count: 40, packs_sold: 10, primary_spend_unknown_count: 0, inferred_primary_count: 0 }
    expect(packCoverage(t).plWithheld).toBe(false)
  })

  it("an empty wallet is not withheld (nothing to subtract)", () => {
    expect(packCoverage({ packs_purchased: 0, packs_ripped: 0, packs_sold: 0 }).plWithheld).toBe(false)
  })
})
