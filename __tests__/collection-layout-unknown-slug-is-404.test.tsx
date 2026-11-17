import { describe, it, expect, vi } from "vitest"

// 2026-09-25 — `/settings/overview`, `/watchlist/overview`, `/foo/overview`:
// the collection segment layout FELL BACK to the first published collection
// for a slug the registry does not know, so a signed-in reader got NBA Top
// Shot's overview under a foreign URL with HTTP 200 and a self-canonical. That
// is the SUBSTITUTION face of the honesty rule and a soft 404. An unknown
// collection is a 404; the registry decides what a collection is.

const NOT_FOUND = new Error("NEXT_NOT_FOUND")
vi.mock("next/navigation", () => ({
  notFound: () => { throw NOT_FOUND },
  redirect: (u: string) => { throw new Error(`REDIRECT:${u}`) },
}))
// The chrome the layout renders is not under test; keep it inert.
vi.mock("@/components/collection-chrome", () => ({
  CollectionTicker: () => null,
  CollectionBanner: () => null,
}))
vi.mock("@/components/WalletHydrator", () => ({ default: () => null }))
vi.mock("@/components/FunnelTracker", () => ({ default: () => null }))
vi.mock("@/components/WalletSearchBand", () => ({ default: () => null }))
vi.mock("@/app/(collections)/[collection]/ActiveCollectionSync", () => ({ default: () => null }))

const { default: Layout } = await import("@/app/(collections)/[collection]/layout")

const render = (collection: string) =>
  Layout({ params: Promise.resolve({ collection }), children: null })

describe("collection segment layout — an unknown slug is a 404, never another collection's page", () => {
  it.each(["settings", "watchlist", "trophy-cases", "foo", "undefined"])("%s → notFound()", async (slug) => {
    await expect(render(slug)).rejects.toBe(NOT_FOUND)
  })

  it("no-change control: a registry collection still renders its shell", async () => {
    const el = await render("nba-top-shot")
    expect(el).toBeTruthy()
    // The shell is tagged with the collection it IS — never a fallback.
    expect((el as { props?: { "data-collection"?: string } }).props?.["data-collection"]).toBe("nba-top-shot")
  })

  it("no-change control: an unpublished registry collection still gets its Coming Soon shell, not a 404", async () => {
    const { COLLECTIONS } = await import("@/lib/collections")
    const unpublished = COLLECTIONS.find((c) => !c.published)
    if (!unpublished) return // nothing unpublished in the registry today — nothing to control
    const el = await render(unpublished.id)
    expect((el as { props?: { "data-collection"?: string } }).props?.["data-collection"]).toBe(unpublished.id)
  })
})
