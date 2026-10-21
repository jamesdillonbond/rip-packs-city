// 2026-10-20 live sweep: /moment/52684229 (Olivia Miles #25/29) read "Owner @KIDD082003"
// while its own Recent activity showed two later sales; the moments snapshot predated both.
import { describe, it, expect } from "vitest"
import { ownerCorrectedBySale } from "@/lib/moment-detail/fetchers"

const ss = (over: Record<string, unknown> = {}): { owner_address?: string | null; owner_from_last_sale?: boolean; last_sale?: { sold_at?: string | null; buyer_address?: string | null } | null } => ({
  owner_address: "0xkidd",
  last_sale: { sold_at: "2026-10-20T14:58:00Z", buyer_address: "0xsteve" },
  ...over,
})

describe("ownerCorrectedBySale", () => {
  it("a sale NEWER than the owner snapshot names the owner", () => {
    const out = ownerCorrectedBySale(ss(), "2026-10-20T00:27:00Z")
    expect(out.owner_address).toBe("0xsteve")
    expect(out.owner_from_last_sale).toBe(true)
  })
  it("a snapshot newer than the sale wins (a transfer after it)", () => {
    expect(ownerCorrectedBySale(ss(), "2026-10-21T00:00:00Z").owner_address).toBe("0xkidd")
  })
  it("unknown timestamps or a matching buyer change nothing", () => {
    expect(ownerCorrectedBySale(ss(), null).owner_address).toBe("0xkidd")
    expect(ownerCorrectedBySale(ss({ last_sale: { sold_at: null, buyer_address: "0xsteve" } }), "2026-10-19T00:00:00Z").owner_address).toBe("0xkidd")
    const same = ss({ owner_address: "0xSTEVE" })
    expect(ownerCorrectedBySale(same, "2026-10-19T00:00:00Z")).toBe(same)
  })
})
