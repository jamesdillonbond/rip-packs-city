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
  it("passes non-JSON through untouched", () => {
    expect(scrubConfidence("not json")).toBe("not json")
  })
})
