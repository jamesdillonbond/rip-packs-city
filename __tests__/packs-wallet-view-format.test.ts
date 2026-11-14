import { describe, it, expect } from "vitest"
import {
  packValueLabel, packUnrealizedUsd, packHeldPullsLabel, packHeldFmvLabel, packRoiLabel, packHoldLabel,
  packTabMetrics, pullsHeldLine,
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
  packInferredAcquisitionLine,
  packPullSerialLabel,
  packsRippedCaption,
  spentCaption,
  packsSoldCaption,
  packMarketLabel,
  heldPacksCaption,
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
    expect(realizedPlTint(-1)).toBe("var(--rpc-red-text)")
  })
})

// ⚠ RE-PINNED 2026-10-18: a P/L figure is TEXT, so the loss red is the text-safe
// token (--rpc-red-text, AA in both themes), not the fill red (#E03A2F, 4.15–4.45:1).
describe("netPlTint", () => {
  it("green when a value exists and is >= 0", () => {
    expect(netPlTint(0)).toBe("#34D399")
    expect(netPlTint(500)).toBe("#34D399")
  })
  it("red when negative or absent", () => {
    expect(netPlTint(-5)).toBe("var(--rpc-red-text)")
    expect(netPlTint(null)).toBe("var(--rpc-red-text)")
    expect(netPlTint(undefined)).toBe("var(--rpc-red-text)")
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
  it("says a sealed pack is still being identified (never that it cannot be), instead of faking a name", () => {
    const note = packIdentityNote({ dist_id: null, status: "held" }) ?? ""
    expect(note).toMatch(/^Sealed · still identifying/)
    // 2026-11-07: the old line claimed the drop is "not recorded until opened or resold" — false
    // since the searchPackNft lane (09-18) and the chain mint tail (11-07) name sealed packs.
    expect(note).not.toMatch(/not recorded|until opened/)
    expect(note).not.toMatch(/Pack #/)
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
  })  // 2026-10-10 (#187): a pack out of a box this wallet opened was never bought on its own.
  it("says a pack came from a box -- never a $0 or retail buy", () => {
    expect(packBuyLabel({ has_buy: false, buy_usd: null, buy_price_source: "box" })).toBe("From a box")
    expect(packInferredAcquisitionLine({ has_buy: false, buy_price_source: "box" }))
      .toBe("Came out of a box you opened · its cost is part of the box's price")
    // a pack the wallet DID buy says nothing extra, whatever the source
    expect(packInferredAcquisitionLine({ has_buy: true, buy_price_source: "box" })).toBeNull()
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
    expect(packMarketLabel({ lowest_ask_usd: 22.5, pack_gross_ev_usd: 31.2, last_sale_usd: 19 })).toBe("Ask $22.50 · Rip EV $31.20 · Last $19.00")
    expect(packMarketLabel({ lowest_ask_usd: null, pack_gross_ev_usd: 31.2 })).toBe("Rip EV $31.20")
    // 2026-09-26: the NET figure (contents minus drop price) is never labelled EV --
    // an Anthology Quick Rip worth $2.33 inside read "EV -$6.67"
    expect(packMarketLabel({ lowest_ask_usd: 10, pack_ev_usd: -6.67, pack_gross_ev_usd: 2.33 })).toBe("Ask $10.00 · Rip EV $2.33")
    expect(packMarketLabel({ pack_ev_usd: -6.67 })).not.toMatch(/EV/)
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
  it("an unrecorded acquisition says what its inferred cost rests on", () => {
    expect(packInferredAcquisitionLine({ has_buy: false, buy_price_source: "retail_inferred", primary_minted_at: "2024-09-07T19:00:00Z" }))
      .toBe("Bought at the drop · minted Sep 7, 2024, no marketplace sale before yours")
    expect(packInferredAcquisitionLine({ has_buy: false, buy_price_source: "retail_inferred", minted_to_wallet_at: "2026-04-24T11:15:01Z", primary_minted_at: null }))
      .toBe("Minted into this wallet by Dapper · Apr 24, 2026")
    expect(packInferredAcquisitionLine({ has_buy: false, buy_price_source: "retail_inferred" })).toBe("No purchase on record · acquired inside the drop's sale window")
    expect(packInferredAcquisitionLine({ has_buy: false, buy_price_source: null })).toBeNull()
    expect(packInferredAcquisitionLine({ has_buy: true, buy_price_source: "retail", primary_minted_at: "2024-09-07T19:00:00Z" })).toBeNull()
    // a date is PT: 2 AM UTC on Sep 8 is still Sep 7 in Los Angeles
    expect(packInferredAcquisitionLine({ has_buy: false, primary_minted_at: "2024-09-08T02:00:00Z" })).toContain("Sep 7, 2024")
    expect(packInferredAcquisitionLine({ has_buy: false, primary_minted_at: "not a date" })).toBeNull()
  })
  it("a box says what it yielded instead of an unpriced moment count", () => {
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, box_packs: 8 })).toBe("Box · 8 packs")
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, box_packs: 1 })).toBe("Box · 1 pack")
    // 2026-10-10 (v22): how far its packs are realized; the total only once all are
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, box_packs: 7, box_packs_realized: 3, box_realized_usd: 90 }))
      .toBe("Box · 7 packs · 3 of 7 realized")
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, box_packs: 7, box_packs_realized: 7, box_realized_usd: 460 }))
      .toBe("Box · 7 packs · $460.00 realized")
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: null, box_packs: 0, pulls_total: 3, pulls_priced: 2 })).toBe("— (2/3 priced)")
  })
  it("a value resting on inferred pull names reads as an estimate", () => {
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: 12.5, pulls_inferred: 2 })).toBe(`≈${fmtPackUsd(12.5)}`)
    expect(packPullLabel({ status: "ripped", has_rip: true, pull_value_usd: 12.5, pulls_inferred: 0 })).toBe(fmtPackUsd(12.5))
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
    // the single-moment share is said out loud, never folded silently into the count
    expect(packsRippedCaption(3254, 3228, 2736, 1244))
      .toBe("3,228 with a known pull value · 2,736 reconstructed (no pack NFT; 1,244 of them a single moment, which may be a reward)")
    expect(packsRippedCaption(3254, 3228, 2736, 0)).toBe("3,228 with a known pull value · 2,736 reconstructed (no pack NFT)")
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

describe("packsSoldCaption", () => {
  it("names each collection's sales so one collection's count is readable apart from the total", () => {
    expect(packsSoldCaption([
      { collection_name: "NFL All Day", packs_sold: 106 },
      { collection_name: "NBA Top Shot", packs_sold: 396 },
      { collection_name: "LaLiga Golazos", packs_sold: 0 },
    ])).toBe("396 NBA Top Shot · 106 NFL All Day")
  })
  it("says nothing when the headline already is the one collection's number", () => {
    expect(packsSoldCaption([{ collection_name: "NBA Top Shot", packs_sold: 396 }, { collection_name: "NFL All Day", packs_sold: 0 }])).toBeUndefined()
    expect(packsSoldCaption([])).toBeUndefined()
    expect(packsSoldCaption(null)).toBeUndefined()
  })
})

describe("packIdentityNote: minted into the wallet (2026-09-26)", () => {
  it("says Dapper minted it in, dated in PT, even when the distribution is known", () => {
    // 11:15 UTC on 04-24 is 04:15 PT the same day; 03:00 UTC on 04-25 is still 04-24 in PT
    expect(packIdentityNote({ dist_id: "1427", status: "held", minted_to_wallet_at: "2026-04-24T11:15:01.118Z" }))
      .toBe("Minted into this wallet by Dapper · Apr 24, 2026")
    expect(packIdentityNote({ dist_id: "1427", status: "held", minted_to_wallet_at: "2026-04-25T03:00:00Z" }))
      .toBe("Minted into this wallet by Dapper · Apr 24, 2026")
  })
  it("a pack that left the wallet still says so first", () => {
    expect(packIdentityNote({ dist_id: "1427", status: "transferred", minted_to_wallet_at: "2026-04-24T11:15:01Z" }))
      .toMatch(/^Left this wallet/)
  })
  it("no mint on record, or an unreadable date, changes nothing", () => {
    expect(packIdentityNote({ dist_id: "1427", status: "held", minted_to_wallet_at: null })).toBeNull()
    expect(packIdentityNote({ dist_id: "1427", status: "held", minted_to_wallet_at: "not a date" })).toBeNull()
  })
})

describe("heldPacksCaption (2026-09-26)", () => {
  const NOW = Date.parse("2026-09-26T19:00:00Z")
  it("names what each sum covers and how old the oldest ask is (PT)", () => {
    expect(heldPacksCaption({ count: 434, complete: true, rows_read: 434, listed_count: 433, floor_ask_usd: 11042.2,
      oldest_ask_checked_at: "2026-08-27T02:58:21Z", rip_ev_count: 222, rip_ev_usd: 1900.5 }, NOW))
      .toBe("$11,042 at floor ask (433 listed), asks checked since Aug 26 · rip EV $1,901 (222 priced)")
  })
  it("fresh asks carry no age note; a partial read says so first", () => {
    expect(heldPacksCaption({ count: 6000, complete: false, rows_read: 5000, listed_count: 10, floor_ask_usd: 50,
      oldest_ask_checked_at: "2026-09-26T12:00:00Z" }, NOW)).toBe("first 5,000 valued · $50.00 at floor ask (10 listed)")
  })
  it("nothing held, an error, or nothing priced -> no caption (never a $0 value)", () => {
    expect(heldPacksCaption({ count: 0 }, NOW)).toBeUndefined()
    expect(heldPacksCaption({ count: 3, error: "wallet required" }, NOW)).toBeUndefined()
    expect(heldPacksCaption({ count: 3, listed_count: 0, rip_ev_count: 0 }, NOW)).toBeUndefined()
    expect(heldPacksCaption(undefined, NOW)).toBeUndefined()
  })
})

describe("opened-pack averages (2026-09-26)", () => {
  it("a drop with no modelled EV shows what its opened packs yielded, with the count -- never labelled EV", () => {
    expect(packMarketLabel({ lowest_ask_usd: 12, pack_opened_avg_usd: 7.5, pack_opened_n: 41 })).toBe("Ask $12.00 · Opened avg $7.50 (41 packs)")
    expect(packMarketLabel({ pack_opened_avg_usd: 7.5, pack_opened_n: 41 })).not.toMatch(/EV/)
  })
  it("the modelled EV wins when both exist", () => {
    expect(packMarketLabel({ pack_gross_ev_usd: 2.33, pack_opened_avg_usd: 7.5, pack_opened_n: 41 })).toBe("Rip EV $2.33")
  })
  it("the held caption reports opened averages apart from rip EV", () => {
    expect(heldPacksCaption({ count: 434, listed_count: 433, floor_ask_usd: 11042.2, rip_ev_count: 222, rip_ev_usd: 597.66,
      opened_avg_count: 190, opened_avg_usd: 1500 }, Date.parse("2026-09-26T19:00:00Z")))
      .toBe("$11,042 at floor ask (433 listed) · rip EV $597.66 (222 priced) · $1,500 more at their drops' opened averages (190)")
  })
})

describe("packPullSerialLabel", () => {
  it("shows serial and mint size", () => {
    expect(packPullSerialLabel(459, 15000)).toBe("#459 / 15,000")
  })
  it("reads the numeric strings a jsonb payload can carry", () => {
    expect(packPullSerialLabel("12", "99")).toBe("#12 / 99")
  })
  it("drops a mint size it cannot trust", () => {
    expect(packPullSerialLabel(7, null)).toBe("#7")
    expect(packPullSerialLabel(7, 0)).toBe("#7")
  })
  it("says nothing without a real serial -- never #0 or #null", () => {
    expect(packPullSerialLabel(null, 100)).toBeNull()
    expect(packPullSerialLabel(undefined, 100)).toBeNull()
    expect(packPullSerialLabel(0, 100)).toBeNull()
    expect(packPullSerialLabel("", 100)).toBeNull()
    expect(packPullSerialLabel("abc", 100)).toBeNull()
  })
})

// ── 2026-11-13 (get_wallet_pack_history v27): per-tab columns + metrics ─────────

describe("v27 per-row columns never render an unknown as $0", () => {
  it("a sealed pack's value names its basis, and no value is a dash", () => {
    expect(packValueLabel({ value_usd: 25, value_basis: "ask" })).toBe("$25.00 · floor ask")
    expect(packValueLabel({ value_usd: 18, value_basis: "last_sale" })).toBe("$18.00 · last sale")
    expect(packValueLabel({ value_usd: null, value_basis: null })).toBe("—")
    expect(packValueLabel({})).toBe("—")
  })
  it("unrealized needs a value AND a cost, and a pack from a box has no cost of its own", () => {
    expect(packUnrealizedUsd({ value_usd: 25, buy_usd: 10 })).toBe(15)
    expect(packUnrealizedUsd({ value_usd: 8, buy_usd: 10 })).toBe(-2)
    expect(packUnrealizedUsd({ value_usd: 25, buy_usd: null })).toBeNull()
    expect(packUnrealizedUsd({ value_usd: null, buy_usd: 10 })).toBeNull()
    expect(packUnrealizedUsd({ value_usd: 25, buy_usd: 0, buy_price_source: "box" })).toBeNull()
  })
  it("still-held pulls say when the list is partial", () => {
    expect(packHeldPullsLabel({ pulls_listed: 3, pulls_held: 2, moments_pulled: 3 })).toBe("2 of 3")
    expect(packHeldPullsLabel({ pulls_listed: 2, pulls_held: 2, moments_pulled: 4 })).toBe("2 of 2 named")
    expect(packHeldPullsLabel({ pulls_listed: 0, pulls_held: 0 })).toBe("—")
    expect(packHeldPullsLabel({})).toBe("—")
  })
  it("held FMV: a real $0 when none is held, a coverage note when one held pull is unpriced", () => {
    expect(packHeldFmvLabel({ pulls_listed: 3, pulls_held: 2, pulls_held_priced: 2, held_fmv_usd: 12 })).toBe("$12.00")
    expect(packHeldFmvLabel({ pulls_listed: 2, pulls_held: 0, pulls_held_priced: 0, held_fmv_usd: 0 })).toBe("$0")
    expect(packHeldFmvLabel({ pulls_listed: 2, pulls_held: 2, pulls_held_priced: 1, held_fmv_usd: null })).toBe("— (1/2 priced)")
    // no pull list at all: unknown, never $0
    expect(packHeldFmvLabel({ pulls_listed: null, pulls_held: null, held_fmv_usd: null })).toBe("—")
  })
  it("ROI and hold time need both ends", () => {
    expect(packRoiLabel({ realized_pl_usd: 15, buy_usd: 10 })).toBe("+150%")
    expect(packRoiLabel({ realized_pl_usd: -5, buy_usd: 10 })).toBe("-50%")
    expect(packRoiLabel({ realized_pl_usd: 5, buy_usd: 0 })).toBe("—")
    expect(packRoiLabel({ realized_pl_usd: null, buy_usd: 10 })).toBe("—")
    expect(packHoldLabel("2026-10-01T00:00:00Z", "2026-10-13T00:00:00Z")).toBe("12d")
    expect(packHoldLabel("2026-10-01T00:00:00Z", "2026-10-01T05:00:00Z")).toBe("5h")
    expect(packHoldLabel(null, "2026-10-13T00:00:00Z")).toBe("—")
    expect(packHoldLabel("2026-10-13T00:00:00Z", "2026-10-01T00:00:00Z")).toBe("—")
  })
})

describe("v27 tab metrics: every sum names the rows it covers; a sum over none is a dash", () => {
  const now = Date.parse("2026-11-13T20:00:00Z")
  it("unopened: value over 2 of 3, unrealized over the 1 with both, old asks dated", () => {
    const m = packTabMetrics("unopened", {
      packs: 3, held_packs: 3, cost_usd: 14, cost_known: 2, held_value_usd: 43, held_valued: 2, held_valued_by_ask: 1,
      held_ask_oldest_checked_at: "2026-08-27T02:58:21Z", held_unrealized_usd: 15, held_unrealized_n: 1,
    }, now)
    const by = Object.fromEntries(m.map((x) => [x.label, x]))
    expect(by["Sealed packs"].value).toBe("3")
    expect(by["Cost basis"].value).toBe("$14.00")
    expect(by["Cost basis"].caption).toBe("across 2 of 3")
    expect(by["Market value"].value).toBe("$43.00")
    expect(by["Market value"].caption).toBe("across 2 of 3 · asks checked since Aug 26")
    expect(by["Unrealized"].value).toBe("$15.00")
    expect(by["Unrealized"].tone).toBe("positive")
  })
  it("unopened with nothing valued shows a dash, never $0", () => {
    const m = packTabMetrics("unopened", { packs: 2, held_packs: 2, cost_known: 0, cost_usd: null, held_valued: 0, held_value_usd: null, held_unrealized_n: 0, held_unrealized_usd: null }, now)
    for (const x of m.filter((x) => x.label !== "Sealed packs")) expect(x.value).toBe("—")
  })
  it("opened: the wallet FMV of pulls still held, with how many and how many priced", () => {
    const m = packTabMetrics("opened", {
      packs: 4, opened_packs: 4, opened_with_pull_list: 4, pulls_listed: 9, pulls_held: 5, pulls_held_priced: 4,
      held_fmv_usd: 17.5, pull_value_usd: 33, pull_valued: 3, cost_usd: null, cost_known: 0, realized_pl_usd: null, realized_pl_known: 0,
    }, now)
    const held = m.find((x) => x.label === "Still held · wallet FMV")!
    expect(held.value).toBe("$17.50")
    expect(held.caption).toBe("5 of 9 pulls still held · 4 priced")
    expect(m.find((x) => x.label === "Pull value")!.caption).toBe("across 3 of 4")
    expect(m.find((x) => x.label === "Cost")!.value).toBe("—")
    expect(m.find((x) => x.label === "Realized P&L")!.tone).toBe("muted")
  })
  it("opened with no pull list held says so instead of $0", () => {
    const held = packTabMetrics("opened", { packs: 2, opened_packs: 2, pulls_listed: 0, pulls_held: 0, held_fmv_usd: 0 }, now)
      .find((x) => x.label === "Still held · wallet FMV")!
    expect(held.value).toBe("—")
    expect(held.caption).toBe("no pull list held yet")
  })
  it("sold: proceeds, avg sale, P&L over the rows that carry it", () => {
    const m = packTabMetrics("sold", { packs: 4, sold_packs: 4, proceeds_usd: 100, proceeds_known: 4, cost_usd: 30, cost_known: 2, realized_pl_usd: -6, realized_pl_known: 2 }, now)
    const by = Object.fromEntries(m.map((x) => [x.label, x]))
    expect(by["Proceeds"].value).toBe("$100.00")
    expect(by["Avg sale"].value).toBe("$25.00")
    expect(by["Realized P&L"].value).toBe("-$6.00")
    expect(by["Realized P&L"].tone).toBe("negative")
    expect(by["Realized P&L"].caption).toBe("across 2 of 4")
  })
  it("an older payload with no tab_totals renders no tiles", () => {
    expect(packTabMetrics("sold", undefined)).toEqual([])
  })
})

describe("pullsHeldLine (dashboard pack details, 2026-11-13)", () => {
  it("counts held pulls and sums their wallet FMV, naming unpriced ones", () => {
    expect(pullsHeldLine([{ still_held: true, wallet_fmv_usd: 5.75 }, { still_held: false }, { still_held: true, wallet_fmv_usd: 1 }], true)).toBe("2 of 3 still held · $6.75 wallet FMV")
    expect(pullsHeldLine([{ still_held: true, wallet_fmv_usd: 5 }, { still_held: true, wallet_fmv_usd: null }], true)).toBe("2 of 2 still held · $5.00 wallet FMV (1 of 2 priced)")
    expect(pullsHeldLine([{ still_held: true, wallet_fmv_usd: null }], true)).toBe("1 of 1 still held")
    expect(pullsHeldLine([{ still_held: false }, { still_held: false }], true)).toBe("none still held")
  })
  it("a failed check says so -- never 'none still held'; no scoped answer says nothing", () => {
    expect(pullsHeldLine([{}, {}], false)).toBe("couldn't check which of these you still hold")
    expect(pullsHeldLine([{}, {}], null)).toBeNull()
    expect(pullsHeldLine([{}, {}], undefined)).toBeNull()
  })
})
