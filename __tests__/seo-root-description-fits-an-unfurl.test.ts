import { describe, it, expect } from "vitest"
import { COLLECTIONS } from "@/lib/collections"
import { rootMetadata, ROOT_DESCRIPTION_MAX, ROOT_OG_CONTENT, ROOT_OG_IMAGE } from "@/lib/seo"

// The homepage description is what every unfurl (iMessage, Slack, X, Facebook,
// Google) shows under the card, and they all truncate around 150–160 chars.
// Measured 2026-11-16: the old sentence was 235 chars and lost its last two
// collections in every preview. It is registry-driven, so publishing a new
// collection lengthens it with no edit to lib/seo.ts — this is the guard that
// turns that into a visible decision.

describe("root description fits an unfurl", () => {
  const description = rootMetadata.description as string
  const published = COLLECTIONS.filter((c) => c.published)

  it("stays within the unfurl limit", () => {
    expect(description.length).toBeGreaterThan(40)
    expect(description.length).toBeLessThanOrEqual(ROOT_DESCRIPTION_MAX)
  })

  it("still names every published collection (shorten the lead-in, never drop a name)", () => {
    // Count inspected, so an empty registry walk cannot pass vacuously.
    expect(published.length).toBeGreaterThan(0)
    for (const c of published) expect(description).toContain(c.label)
  })

  it("is the same sentence in the meta, OG and Twitter blocks", () => {
    expect(ROOT_OG_CONTENT.description).toBe(description)
    expect((rootMetadata.openGraph as { description?: string }).description).toBe(description)
    expect((rootMetadata.twitter as { description?: string }).description).toBe(description)
  })

  it("points the root card at the cache-busted default image in both blocks", () => {
    expect(ROOT_OG_IMAGE.startsWith("/api/og/default")).toBe(true)
    expect(ROOT_OG_CONTENT.images[0].url).toBe(ROOT_OG_IMAGE)
    const tw = (rootMetadata.twitter as { images?: Array<{ url: string }> }).images
    expect(tw?.[0]?.url).toBe(ROOT_OG_IMAGE)
  })
})
