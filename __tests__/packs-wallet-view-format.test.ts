import { describe, it, expect } from "vitest"
import {
  PACK_FILTER_STATUS,
  PACK_FILTER_LABEL,
  PACK_FILTERS,
  STATUS_COLOR,
  packStatusColor,
  realizedPlTint,
  netPlTint,
  packDisplayName,
  fmtPackUsd,
  relativePackTime,
  packIdentityNote,
  packBuyLabel,
  packPullLabel,
  packsRippedCaption,
  spentCaption,
  packMarketLabel,
  identitySyncNote,
} from "@/lib/packs-wallet-view-format"

// Pins the pure formatting/mapping logic lifted out of
// components/packs/WalletPacksView.tsx (invisible to the coverage ratchet).
// A regression here mis-maps a sub-filter to the wrong server status, mis-tints
// P&L, or mangles the "when"/USD columns.

describe("PACK_FILTER_STATUS", () => {
  it("maps the Sold tab to sold_any (flipped + sold), not sold", () => {
    expect(PACK_FILTER_STATUS.unopened).toBe("held")
    expect(PACK_FILTER_STATUS.opened).toBe("ripped")
    expect(PACK_FILTER_STATUS.sold).toBe("sold_any")
  })
})

describe("PACK_FILTER_LABEL / PACK_FILTERS", () => {
  it("labels each filter", () => {
    expect(PACK_FILTER_LABEL.unopened).toBe("Unopened")
    expect(PACK_FILTER_LABEL.opened).toBe("Opened")
    expect(PACK_FILTER_LABEL.sold).toBe("Sold")
  })
  it("renders the tabs in unopened → opened → sold order", () => {
    expect(PACK_FILTERS).toEqual(["unopened", "opened", "sold"])
  })
  it("has a label + status for every filter tab", () => {
    for (const f of PACK_FILTERS) {
      expect(PACK_FILTER_LABEL[f]).toBeTruthy()
      expect(PACK_FILTER_STATUS[f]).toBeTruthy()
    }
  })
})

describe("packStatusColor", () => {
  it("maps each known status to its chip color", () => {
    expect(packStatusColor("ripped")).toBe(STATUS_COLOR.ripped)
    expect(packStatusColor("flipped")).toBe("#A855F7")
    expect(packStatusColor("sold")).toBe("#34D399")
    expect(packStatusColor("held")).toBe("var(--rpc-text-muted)")
    expect(packStatusColor("other")).toBe("var(--rpc-text-muted)")
  })
  it("falls back to muted for an unexpected status", () => {
    expect(packStatusColor("mystery")).toBe("var(--rpc-text-muted)")
    expect(packStatusColor("")).toBe("var(--rpc-text-muted)")
  })
})

describe("realizedPlTint", () => {
  it("muted for null/undefined", () => {
    expect(realizedPlTint(null)).toBe("var(--rpc-text-muted)")
    expect(realizedPlTint(undefined)).toBe("var(--rpc-text-muted)")
  })
  it("green for >= 0", () => {
    expect(realizedPlTint(0)).toBe("#34D399")
    expect(realizedPlTint(12.5)).toBe("#34D399")
  })
  it("red for < 0", () => {
    expect(realizedPlTint(-1)).toBe("var(--rpc-red)")
  })
})

describe("netPlTint", () => {
  it("green when a value exists and is >= 0", () => {
    expect(netPlTint(0)).toBe("#34D399")
    expect(netPlTint(500)).toBe("#34D399")
  })
  it("red when negative or absent", () => {
    expect(netPlTint(-5)).toBe("var(--rpc-red)")
    expect(netPlTint(null)).toBe("var(--rpc-red)")
    expect(netPlTint(undefined)).toBe("var(--rpc-red)")
  })
})

describe("packDisplayName", () => {
  it("uses the pack name when present", () => {
    expect(packDisplayName("Cosmic Pack", "1234567890")).toBe("Cosmic Pack")
  })
  it("falls back to the last 6 chars of the nft id when unnamed", () => {
    expect(packDisplayName(null, "1234567890")).toBe("Pack #567890")
    expect(packDisplayName(undefined, "abc")).toBe("Pack #abc")
  })
  it("keeps an empty-string name (not null) as-is", () => {
    // `?? ` only falls back on null/undefined, so a literal "" stays "".
    expect(packDisplayName("", "1234567890")).toBe("")
  })
})

describe("fmtPackUsd", () => {
  it("em-dash for null/undefined/non-finite", () => {
    expect(fmtPackUsd(null)).toBe("—")
    expect(fmtPackUsd(undefined)).toBe("—")
    expect(fmtPackUsd(Number.NaN)).toBe("—")
    expect(fmtPackUsd(Number.POSITIVE_INFINITY)).toBe("—")
  })
  it("exact $0 for zero", () => {
    expect(fmtPackUsd(0)).toBe("$0")
  })
  it("2-decimal formatting under $1000", () => {
    expect(fmtPackUsd(12.5)).toBe("$12.50")
    expect(fmtPackUsd(3.1)).toBe("$3.10")
    expect(fmtPackUsd(-4.2)).toBe("-$4.20")
  })
  it("rounds and adds thousands separators at/above $1000", () => {
    expect(fmtPackUsd(1000)).toBe("$1,000")
    expect(fmtPackUsd(1234.6)).toBe("$1,235")
    expect(fmtPackUsd(-2500)).toBe("-$2,500")
  })
})

describe("relativePackTime", () => {
  const now = Date.parse("2026-07-24T12:00:00Z")
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it("em-dash for null/undefined", () => {
    expect(relativePackTime(null, now)).toBe("—")
    expect(relativePackTime(undefined, now)).toBe("—")
  })
  it("em-dash for an unparseable date (NaN delta)", () => {
    expect(relativePackTime("not-a-date", now)).toBe("—")
  })
  it("'just now' under a minute", () => {
    expect(relativePackTime(ago(30_000), now)).toBe("just now")
  })
  it("minutes", () => {
    expect(relativePackTime(ago(5 * 60_000), now)).toBe("5m ago")
    expect(relativePackTime(ago(59 * 60_000), now)).toBe("59m ago")
  })
  it("hours", () => {
    expect(relativePackTime(ago(3 * 3_600_000), now)).toBe("3h ago")
    expect(relativePackTime(ago(23 * 3_600_000), now)).toBe("23h ago")
  })
  it("days", () => {
    expect(relativePackTime(ago(2 * 86_400_000), now)).toBe("2d ago")
    expect(relativePackTime(ago(29 * 86_400_000), now)).toBe("29d ago")
  })
  it("months", () => {
    expect(relativePackTime(ago(60 * 86_400_000), now)).toBe("2mo ago")
  })
  it("years", () => {
    expect(relativePackTime(ago(400 * 86_400_000), now)).toBe("1y ago")
  })
  it("defaults `now` to the current time when omitted", () => {
    // A moment ~2 hours ago reads as an hours-ago label with the default clock.
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    expect(relativePackTime(twoHoursAgo)).toBe("2h ago")
  })
})

describe("packIdentityNote (2026-09-18)", () => {
  it("says a sealed pack's distribution is not recorded, instead of faking a name", () => {
    expect(packIdentityNote({ dist_id: null, status: "held" })).toMatch(/not recorded/)
  })
  it("says 'Distribution unknown' for a non-sealed row with no dist", () => {
    expect(packIdentityNote({ dist_id: null, status: "ripped" })).toBe("Distribution unknown")
    expect(packIdentityNote({ dist_id: null, status: "sold" })).toBe("Distribution unknown")
  })
  it("says nothing when the distribution is known", () => {
    expect(packIdentityNote({ dist_id: "6224", status: "held" })).toBeNull()
  })
  it("a transferred pack says it left without a recorded sale and names the holder", () => {
    expect(packIdentityNote({ dist_id: "6224", status: "transferred", current_owner: "0xc5ababe825dc3122" })).toBe(
      "Left this wallet without a recorded sale · now held by 0xc5ab…3122",
    )
    expect(packIdentityNote({ dist_id: null, status: "transferred" })).toBe("Left this wallet without a recorded sale")
  })
  it("transferred has its own status color", () => {
    expect(STATUS_COLOR.transferred).toBe("#F59E0B")
    expect(packStatusColor("transferred")).toBe("#F59E0B")
  })
})

describe("packBuyLabel (2026-09-18)", () => {
  it("never renders $0 for an unknown price", () => {
    expect(packBuyLabel({ has_buy: true, buy_usd: null, buy_price: null, buy_price_source: null })).toBe("—")
    expect(packBuyLabel({ has_buy: false, buy_usd: 10 })).toBe("—")
  })
  it("tags a retail-priced primary drop, and a $0 retail as a reward pack", () => {
    expect(packBuyLabel({ has_buy: true, buy_usd: 10, buy_price_source: "retail" })).toBe("$10.00 retail")
    expect(packBuyLabel({ has_buy: true, buy_usd: 0, buy_price_source: "retail" })).toBe("$0 (reward)")
  })
  it("renders a secondary buy as plain dollars when the unit is dollar-pegged, with the code otherwise (2026-09-25)", () => {
    // Trevor: DUC is 1:1 USD and the site never shows the word — "$10.00", not "$10.00 DUC".
    expect(packBuyLabel({ has_buy: true, buy_usd: 10, buy_price: 10, buy_currency: "DUC", buy_price_source: "onchain" })).toBe("$10.00")
    expect(packBuyLabel({ has_buy: true, buy_usd: 30, buy_currency: "USD", buy_price_source: "marketplace" })).toBe("$30.00")
    expect(packBuyLabel({ has_buy: true, buy_usd: 30, buy_currency: "FLOW", buy_price_source: "onchain" })).toBe("$30.00 FLOW")
  })
  it("falls back to buy_price when buy_usd is absent (older payloads)", () => {
    expect(packBuyLabel({ has_buy: true, buy_price: 8, buy_currency: "DUC" })).toBe("$8.00")
  })
})

describe("identitySyncNote (2026-09-18)", () => {
  const now = Date.parse("2026-09-19T00:00:00Z")
  it("never calls an unsynced list complete", () => {
    expect(identitySyncNote(null)).toMatch(/not yet confirmed/)
    expect(identitySyncNote({ requested_at: "2026-09-18T23:58:00Z", completed_at: null }, now)).toMatch(/Confirming holdings/)
  })
  it("reports a completed sync with its age and pack count", () => {
    expect(identitySyncNote({ completed_at: "2026-09-18T22:00:00Z", packs: 434 }, now)).toBe(
      "Holdings confirmed with the Dapper pack index 2h ago (434 packs).",
    )
  })
  it("says a failed sync may have left the list incomplete", () => {
    expect(identitySyncNote({ completed_at: "2026-09-18T22:00:00Z", packs: 100, last_error: "http_503" }, now)).toMatch(/failed 2h ago .*incomplete/)
  })
})

describe("packMarketLabel (2026-09-18)", () => {
  it("joins only the parts that are known", () => {
    expect(packMarketLabel({ lowest_ask_usd: 22.5, pack_ev_usd: 31.2, last_sale_usd: 19 })).toBe("Ask $22.50 · EV $31.20 · Last $19.00")
    expect(packMarketLabel({ lowest_ask_usd: null, pack_ev_usd: 31.2 })).toBe("EV $31.20")
    expect(packMarketLabel({})).toBe("")
  })
})

describe("packPullLabel (2026-09-26)", () => {
  it("prints a known pull value", () => {
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: 12.5 })).toBe(fmtPackUsd(12.5))
  })
  it("never renders an unknown pull value as $0 — it says how close the pull list is", () => {
    const label = packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, pulls_total: 3, pulls_priced: 2 })
    expect(label).toBe("— (2/3 priced)")
    expect(label).not.toMatch(/\$0/)
  })
  it("an index-only opened pack (no rip row of ours) still shows its value", () => {
    expect(packPullLabel({ status: "ripped", has_rip: false, pull_value_usd: 4 })).toBe(fmtPackUsd(4))
  })
  it("a pack that was never opened has no pull value", () => {
    expect(packPullLabel({ status: "held", has_rip: false, pull_value_usd: null, pulls_total: 3, pulls_priced: 3 })).toBe("—")
  })
  it("unknown with no pull list is a bare dash", () => {
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null })).toBe("—")
  })
})

describe("packsRippedCaption (2026-09-26)", () => {
  it("says how many rips are reconstructions, so one never reads as an open event we hold", () => {
    expect(packsRippedCaption(3254, 3228, 2736)).toBe("3,228 with a known pull value · 2,736 reconstructed (no pack NFT)")
  })
  it("no reconstructions -> the old caption, unchanged", () => {
    expect(packsRippedCaption(10, 10, 0)).toBe("all valued")
    expect(packsRippedCaption(10, 4, undefined)).toBe("4 with a known pull value")
  })
  it("coverage unknown and nothing reconstructed -> no caption", () => {
    expect(packsRippedCaption(10, undefined, null)).toBeUndefined()
  })
})

describe("inferred drop cost (2026-09-26)", () => {
  it("shows an inferred retail on a pack with no buy row, labelled as inferred", () => {
    expect(packBuyLabel({ has_buy: false, buy_usd: 25, buy_price_source: "retail_inferred" })).toBe("$25.00 retail (inferred)")
    expect(packBuyLabel({ has_buy: false, buy_usd: 0, buy_price_source: "retail_inferred" })).toBe("$0 (reward, inferred)")
  })
  it("a pack with no buy row and nothing inferred is still a dash, never $0", () => {
    expect(packBuyLabel({ has_buy: false, buy_usd: null, buy_price_source: null })).toBe("—")
  })
  it("the spend caption says the inferred cost apart from the recorded one", () => {
    expect(spentCaption(258, 261, 307, 13599)).toBe("across 258 of 261 packs with a known price · + $13,599 at drop retail for 307 more packs (inferred)")
    expect(spentCaption(5, 5, 0, 0)).toBeUndefined()
    expect(spentCaption(5, 5, undefined, undefined)).toBeUndefined()
  })
})
