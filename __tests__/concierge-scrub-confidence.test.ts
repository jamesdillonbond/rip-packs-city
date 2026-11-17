import { describe, it, expect } from "vitest"
import { scrubConfidence } from "@/lib/concierge/scrub-confidence"

// 2026-10-24: real answers said "LOW confidence", "STALE" and drew a Confidence
// column because tool results carried the tier. The model must never see it.
describe("scrubConfidence", () => {
  it("replaces every confidence tier with a plain-language basis, nested and in arrays", () => {
    const raw = JSON.stringify({
      status: "ok",
      fmv: 7.8,
      fmv_confidence: "LOW",
      rows: [{ fmv: 1, confidence: "STALE" }, { fmv: 2, confidence: "ASK_ONLY" }],
      sample: { by_confidence: { HIGH: 3, LOW: 1 }, low_confidence_fmv: true },
    })
    const out = scrubConfidence(raw)
    expect(out).not.toMatch(/confidence/i)
    expect(out).not.toMatch(/"(HIGH|MEDIUM|LOW|STALE|ASK_ONLY|SALES_ONLY|NO_DATA)"/)
    const j = JSON.parse(out)
    expect(j.fmv_pricing_basis).toMatch(/very few sales/)
    expect(j.rows[1].pricing_basis).toMatch(/asking prices/)
    expect(j.sample.thin_pricing_fmv).toBe(true)
    expect(j.fmv).toBe(7.8)
  })
  // 2026-11-12, live: asked about a $6.18 price sitting between a $6.00 offer and a $12.50 ask, the
  // concierge said "estimated from current asking prices, not sales" — the offer-pull sentence was in
  // a sibling field it ignored. The basis the model reads must carry the rule itself.
  it("a price a rule moved does not read as plain asking prices — the basis names the rule", () => {
    const pull = "moved between the lowest ask and the best open offer, weighted toward the offer"
    const out = scrubConfidence(JSON.stringify({ fmv_usd: 6.18, confidence: "ASK_ONLY", price_adjustments: [pull] }))
    const j = JSON.parse(out)
    expect(j.pricing_basis).toContain(pull)
    expect(j.pricing_basis).not.toMatch(/not sales$/)
    expect(j.pricing_basis).not.toBe("estimated from current asking prices, not sales")
    expect(out).not.toMatch(/confidence|ASK_ONLY/)
    // nested single-edition shape (get_fmv) and an untouched row beside it
    const nested = JSON.parse(scrubConfidence(JSON.stringify({
      edition: { confidence: "LOW", price_adjustments: [pull] },
      other: { confidence: "ASK_ONLY", price_adjustments: [] },
    })))
    expect(nested.edition.pricing_basis).toMatch(/very few sales.*then moved between/)
    expect(nested.other.pricing_basis).toBe("estimated from current asking prices, not sales")
  })
  it("passes non-JSON through untouched", () => {
    expect(scrubConfidence("not json")).toBe("not json")
  })
})
