import { describe, it, expect } from "vitest"
import {
  publishedCollections,
  getPublishedCollection,
  requirePublishedCollection,
  collectionHasPage,
  getCollection,
} from "@/lib/collections"

// The published-collection gating helpers decide what an anon/route can reach.
// A regression here either exposes an unpublished collection or 500s a live one.

const pub = publishedCollections()
const first = pub[0]

describe("getPublishedCollection", () => {
  it("returns a published collection by id", () => {
    expect(getPublishedCollection(first.id)?.id).toBe(first.id)
  })
  it("returns undefined for an unknown id", () => {
    expect(getPublishedCollection("not-a-real-collection")).toBeUndefined()
  })
  it("returns undefined for a collection that exists but is NOT published", () => {
    // Panini is the registry's unpublished placeholder (Candy was published 2026-09-06).
    const unpublished = ["panini-blockchain", "rwa"].map((id) => getCollection(id)).filter(Boolean)
    expect(unpublished.length).toBeGreaterThan(0)
    for (const c of unpublished) expect(getPublishedCollection(c!.id)).toBeUndefined()
  })
  it("returns the published thin collection (Candy MLB, overview only)", () => {
    expect(getPublishedCollection("candy-mlb")?.pages).toEqual(["overview"])
  })
})

describe("requirePublishedCollection", () => {
  it("returns the collection when published", () => {
    expect(requirePublishedCollection(first.id).id).toBe(first.id)
  })
  it("throws for an unknown / unpublished id", () => {
    expect(() => requirePublishedCollection("not-a-real-collection")).toThrow(/not published or not found/)
  })
})

describe("collectionHasPage", () => {
  it("true for a page the collection lists, false for one it doesn't", () => {
    const somePage = first.pages[0]
    expect(collectionHasPage(first.id, somePage)).toBe(true)
    // "badges" is not listed by any collection (per CLAUDE.md route notes)
    expect(collectionHasPage(first.id, "badges" as never)).toBe(false)
  })
  it("false for an unknown collection id", () => {
    expect(collectionHasPage("not-a-real-collection", "overview" as never)).toBe(false)
  })
  it("every published collection lists 'overview' (a universal tab)", () => {
    for (const c of pub) expect(collectionHasPage(c.id, "overview" as never)).toBe(true)
  })
})
