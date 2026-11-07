import { describe, it, expect, vi } from "vitest"

// 2026-11-07 review of the edition page:
//  (1) a malformed escape in the slug threw URIError from generateMetadata — no
//      error boundary wraps metadata, so the response was Next's unbranded 500;
//  (2) a FAILED detail read returned an indexable generic title over a body that
//      says "Couldn't load this edition" — could-not-read must be noindex, follow.
const gate = vi.hoisted(() => ({ fail: false }))
vi.mock("@/lib/entity-detail-gate", async (orig) => ({
  ...(await orig<typeof import("@/lib/entity-detail-gate")>()),
  fetchEntityDetailRaw: async () =>
    gate.fail ? { data: null, error: { message: "canceling statement due to statement timeout" } } : { data: null, error: null },
}))
vi.mock("@/lib/edition/alias-redirect", () => ({ lookupTopShotEditionAliasRedirect: async () => null }))
vi.mock("@/lib/edition/fossil-redirect", () => ({ lookupTopShotFossilRedirect: async () => null }))

type Robots = { index?: boolean; follow?: boolean }
async function meta(collection: string, slug: string) {
  const { generateMetadata } = await import("@/app/(collections)/[collection]/edition/[slug]/page")
  return (await generateMetadata({ params: Promise.resolve({ collection, slug }) } as never)) as { robots?: Robots; title?: unknown }
}

describe("edition page metadata — undecodable slug and failed read", () => {
  it("a malformed escape is NOT FOUND, never a thrown URIError (an unbranded 500)", async () => {
    gate.fail = false
    await expect(meta("nba-top-shot", "%E0%A4")).resolves.toMatchObject({ robots: { index: false, follow: false } })
    await expect(meta("nfl-all-day", "abc%")).resolves.toMatchObject({ robots: { index: false, follow: false } })
  })

  it("a FAILED detail read is unavailable — noindex, but follow stays on (never absent)", async () => {
    gate.fail = true
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const m = await meta("nba-top-shot", "1:2")
      expect(m.robots).toMatchObject({ index: false, follow: true })
    } finally {
      err.mockRestore()
      gate.fail = false
    }
  })
})
