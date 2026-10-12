import { describe, it, expect } from "vitest"
import { metadata } from "@/app/early-access/page"
import { isPublicPath } from "@/proxy"

// /early-access inherited the ROOT title + description verbatim, is anon-public,
// and has zero inbound links — a duplicate of the home page in Google's eyes
// (review §3 E8). Own copy, self-canonical, noindex/follow. Not deleted.
describe("/early-access metadata", () => {
  it("is anon-public, so the metadata matters (control)", () => {
    expect(isPublicPath("/early-access", "GET")).toBe(true)
  })
  it("carries its own title + description, a self-canonical and noindex,follow", () => {
    expect(metadata.title).toBe("Early Access")
    expect(String(metadata.description)).toMatch(/early-access list/i)
    expect(metadata.alternates?.canonical).toBe("https://www.rippackscity.com/early-access")
    expect(metadata.robots).toEqual({ index: false, follow: true })
    expect((metadata.openGraph as { url?: string }).url).toBe("https://www.rippackscity.com/early-access")
  })
  it("does not restate the root title (the duplicate it replaces)", () => {
    expect(String(metadata.title)).not.toMatch(/Intelligence Layer/)
    expect(String(metadata.description)).not.toMatch(/Real-time FMV, deal sniping/)
  })
})
