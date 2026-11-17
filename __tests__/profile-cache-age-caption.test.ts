import { describe, it, expect } from "vitest"
import { cacheAgeCaption } from "@/app/profile/[username]/ProfileClient"

// 2026-09-25: the public profile's saved-wallet card printed a ~6-hourly cached
// FMV beside a LIVE collection breakdown with no caption, so one page showed
// Pinnacle $890.19 and $889.13 for one wallet. The dashboard captions its copy
// "as of Nh ago" above a 2 h threshold; the card now does the same.
describe("cacheAgeCaption", () => {
  const now = Date.parse("2026-09-25T08:00:00Z")
  it("is silent under two hours (noise) and absent for no stamp", () => {
    expect(cacheAgeCaption("2026-09-25T07:00:00Z", now)).toBeNull()
    expect(cacheAgeCaption(null, now)).toBeNull()
    expect(cacheAgeCaption("nonsense", now)).toBeNull()
  })
  it("says the age in hours, then days", () => {
    expect(cacheAgeCaption("2026-09-25T01:59:00Z", now)).toBe("as of 6h ago")
    expect(cacheAgeCaption("2026-09-22T08:00:00Z", now)).toBe("as of 3d ago")
  })
})
