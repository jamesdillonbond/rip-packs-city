import { describe, it, expect } from "vitest"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

// Analytics-surface Next Metadata builder (lib/analytics/seo.ts — distinct from
// lib/seo.ts, tested in seo.test.ts). Locks: canonical = base + path, OG/Twitter
// mirror title+description, default OG image when none supplied, and that a
// custom ogImage overrides the default across both OG and Twitter.

describe("analyticsMetadata", () => {
  it("builds canonical URL from base + path and mirrors title/description", () => {
    const meta = analyticsMetadata({
      title: "Wallets",
      description: "Top wallets",
      path: "/analytics/wallets",
    })
    const canonical = `${ANALYTICS_BASE_URL}/analytics/wallets`
    expect(meta.title).toBe("Wallets")
    expect(meta.description).toBe("Top wallets")
    expect(meta.alternates?.canonical).toBe(canonical)
    expect(meta.openGraph?.url).toBe(canonical)
    expect((meta.openGraph as any)?.siteName).toBe("Rip Packs City")
    expect((meta.openGraph as any)?.type).toBe("website")
  })

  it("defaults the OG image to /api/og/default at 1200x630", () => {
    const meta = analyticsMetadata({ title: "T", description: "D", path: "/analytics" })
    const images = (meta.openGraph as any)?.images
    expect(images).toEqual([{ url: "/api/og/default", width: 1200, height: 630 }])
    expect(meta.twitter?.images).toEqual(["/api/og/default"])
    expect((meta.twitter as any)?.card).toBe("summary_large_image")
  })

  it("uses a supplied ogImage in both OG and Twitter", () => {
    const meta = analyticsMetadata({
      title: "T",
      description: "D",
      path: "/analytics",
      ogImage: "/custom.png",
    })
    expect(((meta.openGraph as any)?.images)[0].url).toBe("/custom.png")
    expect(meta.twitter?.images).toEqual(["/custom.png"])
  })
})
