import { describe, it, expect } from "vitest"
import { serverMomentToRow, ACQUISITION_LABEL_MAP, type ServerMoment } from "@/lib/collection/server-moment"

function sm(over: Partial<ServerMoment> = {}): ServerMoment {
  return {
    moment_id: "m1",
    edition_key: "4:12",
    serial_number: 7,
    fmv_usd: 10,
    confidence: "HIGH",
    low_ask: 12,
    player_name: "LeBron James",
    set_name: "Base Set",
    tier: "COMMON",
    series_number: 4,
    circulation_count: 15000,
    thumbnail_url: "https://x/y.png",
    team_name: "Lakers",
    acquired_at: "2026-01-01T00:00:00Z",
    last_seen_at: null,
    buy_price: null,
    acquisition_method: null,
    acquisition_source: null,
    acquisition_confidence: null,
    loan_principal: null,
    source_address: null,
    is_locked: false,
    ...over,
  }
}

describe("serverMomentToRow", () => {
  it("maps core identity + passes sport through to league", () => {
    const r = serverMomentToRow(sm(), "basketball")
    expect(r.momentId).toBe("m1")
    expect(r.playerName).toBe("LeBron James")
    expect(r.league).toBe("basketball")
    expect(r.editionKey).toBe("4:12")
    // sport omitted → league undefined (not null/empty)
    expect(serverMomentToRow(sm()).league).toBeUndefined()
  })

  it("coerces string/invalid fmv & low_ask to a positive number or null", () => {
    expect(serverMomentToRow(sm({ fmv_usd: "8.5" as any })).fmv).toBe(8.5)
    expect(serverMomentToRow(sm({ fmv_usd: 0 })).fmv).toBeNull()
    expect(serverMomentToRow(sm({ fmv_usd: -3 })).fmv).toBeNull()
    expect(serverMomentToRow(sm({ low_ask: "0" as any })).lowAsk).toBeNull()
    // low_ask mirrors onto topshotAsk/bestAsk and drives bestMarket
    const r = serverMomentToRow(sm({ low_ask: 15 }))
    expect(r.topshotAsk).toBe(15)
    expect(r.bestAsk).toBe(15)
    expect(r.bestMarket).toBe("Top Shot")
    expect(serverMomentToRow(sm({ low_ask: null })).bestMarket).toBeNull()
  })

  it("derives cost basis only for marketplace(buy_price) and loan_default(principal)", () => {
    expect(serverMomentToRow(sm({ acquisition_method: "marketplace", buy_price: 20 })).costBasis).toBe(20)
    expect(serverMomentToRow(sm({ acquisition_method: "marketplace", buy_price: null })).costBasis).toBeNull()
    expect(serverMomentToRow(sm({ acquisition_method: "loan_default", loan_principal: 33 })).costBasis).toBe(33)
    // pack_pull has a label but no derivable basis
    const pull = serverMomentToRow(sm({ acquisition_method: "pack_pull" }))
    expect(pull.costBasis).toBeNull()
    expect(pull.costBasisLabel).toBe(ACQUISITION_LABEL_MAP["pack_pull"])
  })

  // fmvMethod is rendered to the WALLET OWNER as plain English by
  // CollectionMomentTable ("Avg sales price" / "Floor/Ask price" / "—"), so
  // these assertions are an honesty contract, not a naming preference.
  //
  // This test previously pinned the DEFECT: it asserted LOW → "best-offer-only"
  // (rendered "Floor/Ask price" — asserting an ask basis for a price derived
  // from sales) and had no ASK_ONLY case at all, so the one genuinely
  // ask-derived tier silently rendered "—". Corrected 2026-08-04 to key off
  // derivation rather than confidence tier.
  it("maps confidence → fmvMethod by DERIVATION, not by confidence tier", () => {
    // Sale-derived tiers all read as a sales price. LOW is sale-derived too —
    // it is thin/wide sales, not an ask.
    for (const c of ["HIGH", "medium", "LOW", "SALES_ONLY"]) {
      expect(serverMomentToRow(sm({ confidence: c })).fmvMethod).toBe("band")
    }
    // ASK_ONLY is literally 0.90 x one seller's ask (lib/fmv-basis.ts) — it is
    // the ONE tier that must disclose an ask basis. "best-offer-only" is the
    // enum value CollectionMomentTable renders as "Floor/Ask price".
    expect(serverMomentToRow(sm({ confidence: "ASK_ONLY" })).fmvMethod).toBe("best-offer-only")
    expect(serverMomentToRow(sm({ confidence: "ask_only" })).fmvMethod).toBe("best-offer-only")
    // Tiers asserting no current basis stay absent rather than wrong.
    expect(serverMomentToRow(sm({ confidence: "STALE" })).fmvMethod).toBe("none")
    expect(serverMomentToRow(sm({ confidence: null })).fmvMethod).toBe("none")
  })

  it("strips the MOMENT_TIER_ prefix and stringifies series", () => {
    expect(serverMomentToRow(sm({ tier: "MOMENT_TIER_RARE" })).tier).toBe("RARE")
    expect(serverMomentToRow(sm({ tier: "COMMON" })).tier).toBe("COMMON")
    expect(serverMomentToRow(sm({ series_number: 4 })).series).toBe("4")
    expect(serverMomentToRow(sm({ series_number: null })).series).toBeUndefined()
  })

  it("defaults missing player/set names and treats is_locked strictly", () => {
    const r = serverMomentToRow(sm({ player_name: null, set_name: null }))
    expect(r.playerName).toBe("Unknown")
    expect(r.setName).toBe("Unknown Set")
    expect(serverMomentToRow(sm({ is_locked: true })).isLocked).toBe(true)
    expect(serverMomentToRow(sm({ is_locked: false })).isLocked).toBe(false)
  })
})
