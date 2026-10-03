import { describe, it, expect } from "vitest"
import {
  sanitizeVisitSessionId,
  sanitizeVisitReferrer,
  isInternalCheckSessionId,
} from "@/lib/concierge/visit-link"

describe("sanitizeVisitSessionId", () => {
  it("accepts the two shapes lib/track-funnel.ts mints", () => {
    expect(sanitizeVisitSessionId("1b4e28ba-2fa1-11d2-883f-0016d3cca427")).toBe("1b4e28ba-2fa1-11d2-883f-0016d3cca427")
    expect(sanitizeVisitSessionId("s_lx2k9a_3f9q1z")).toBe("s_lx2k9a_3f9q1z")
  })
  it("refuses anything that is not one of ours rather than storing it", () => {
    for (const bad of [null, undefined, 42, "", "short", "x".repeat(65), "has space here", "a;drop table x", "<script>"]) {
      expect(sanitizeVisitSessionId(bad)).toBeNull()
    }
  })
})

describe("sanitizeVisitReferrer", () => {
  it("keeps the attribution string the beacon builds", () => {
    const s = "utm_source=chatgpt.com&ref=https://chatgpt.com/"
    expect(sanitizeVisitReferrer(s)).toBe(s)
  })
  it("caps at 512, strips control characters, and nulls empties", () => {
    expect(sanitizeVisitReferrer("a".repeat(900))).toHaveLength(512)
    expect(sanitizeVisitReferrer("ref=x\u0000\u001b[31m")).toBe("ref=x[31m")
    expect(sanitizeVisitReferrer("   ")).toBeNull()
    expect(sanitizeVisitReferrer({})).toBeNull()
  })
})

describe("isInternalCheckSessionId", () => {
  it("flags internal check prefixes (the 10-02 cowork row)", () => {
    expect(isInternalCheckSessionId("cowork-billing-check-20261002")).toBe(true)
    expect(isInternalCheckSessionId("smoke-degradation-1791037771847")).toBe(true)
    expect(isInternalCheckSessionId("QA_mobile")).toBe(true)
  })
  it("never flags a real widget, default, or bot-bridge session", () => {
    expect(isInternalCheckSessionId("rpc_1b4e28ba-2fa1-11d2-883f-0016d3cca427")).toBe(false)
    expect(isInternalCheckSessionId("anon-1b4e28ba-2fa1-11d2-883f-0016d3cca427")).toBe(false)
    expect(isInternalCheckSessionId("tg:12345")).toBe(false)
    expect(isInternalCheckSessionId("dc:12345")).toBe(false)
    // a prefix word mid-string is not a prefix
    expect(isInternalCheckSessionId("rpc_cowork-x")).toBe(false)
    expect(isInternalCheckSessionId(undefined)).toBe(false)
  })
})
