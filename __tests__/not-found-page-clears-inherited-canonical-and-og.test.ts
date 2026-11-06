import { describe, it, expect } from "vitest"
import { metadata } from "@/app/not-found"

// 2026-11-06 (Search Console: 61 "Duplicate without user-selected canonical" +
// 17 "Google chose different canonical"): Next merges the not-found metadata
// LAST, after every layout above the 404, so a key this object leaves unset is
// INHERITED. Live, every 404 under /<collection>/* carried the collection
// layout's canonical, og:url and og:title (all naming the collection root) and
// the root layout's `index, follow` — a 404 claiming to be a duplicate of the
// hub. A null here is what clears an inherited key (Next's resolveAlternates /
// resolveOpenGraph / resolveTwitter return null for a null source); `undefined`
// or an absent key would inherit.
describe("app/not-found.tsx metadata", () => {
  it("explicitly nulls the inheritable URL-bearing keys", () => {
    expect(metadata).toHaveProperty("alternates", null)
    expect(metadata).toHaveProperty("openGraph", null)
    expect(metadata).toHaveProperty("twitter", null)
  })
  it("overrides the root's index,follow with noindex,nofollow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })
  it("keeps the 404 title and description", () => {
    expect(metadata.title).toBe("404")
    expect(typeof metadata.description).toBe("string")
  })
})
