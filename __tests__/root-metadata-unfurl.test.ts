import { describe, it, expect } from "vitest"
import { rootMetadata } from "@/lib/seo"

// ─────────────────────────────────────────────────────────────────────────────
// The SITE-WIDE unfurl defaults.
//
// 44 files define their own `twitter` block, and Next REPLACES rather than
// merges — so those pages restate what they need. Every OTHER page inherits
// this object verbatim, which makes a gap here a gap on the majority of the
// site at once, and one that is invisible locally: it only shows up in someone
// else's timeline.
// ─────────────────────────────────────────────────────────────────────────────

describe("rootMetadata — the default card", () => {
  it("attributes the card to the site AND the content to the account", () => {
    // `site` was missing entirely, so every inheriting page unfurled with no
    // byline. They are different fields: site = whose card, creator = whose
    // content.
    const t = rootMetadata.twitter as Record<string, unknown>
    expect(t.site).toBe("@RipPacksCity")
    expect(t.creator).toBe("@RipPacksCity")
    expect(t.card).toBe("summary_large_image")
  })

  it("agrees with itself on the handle", () => {
    const t = rootMetadata.twitter as Record<string, unknown>
    expect(t.site).toBe(t.creator)
  })

  it("ships alt text on both default images", () => {
    const og = (rootMetadata.openGraph as any).images[0]
    const tw = (rootMetadata.twitter as any).images[0]
    expect(og.alt).toBeTruthy()
    expect(tw.alt).toBeTruthy()
  })

  it("states the default image dimensions", () => {
    // Without them a crawler must fetch and measure before committing to a
    // large card, and several fall back to a thumbnail rather than wait.
    expect((rootMetadata.openGraph as any).images[0]).toMatchObject({
      width: 1200,
      height: 630,
    })
  })

  it("keeps metadataBase absolute so relative image paths resolve", () => {
    expect(String(rootMetadata.metadataBase)).toMatch(/^https:\/\//)
  })

  it("still declares siteName, type and locale", () => {
    const og = rootMetadata.openGraph as Record<string, unknown>
    expect(og.siteName).toBe("Rip Packs City")
    expect(og.type).toBe("website")
    expect(og.locale).toBe("en_US")
  })
})
