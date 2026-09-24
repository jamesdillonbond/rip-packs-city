import { describe, expect, it, vi } from "vitest"

// A franchise hub link must unfurl as the HUB, not the homepage (2026-09-24).
// The page's generateMetadata set only title/description/alternates/robots, and
// there is no app/teams layout, so `openGraph` and `twitter` fell through to the
// ROOT metadata: homepage copy, homepage image, no og:url. /my-teams cards link
// here, so it is a sharing surface.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/franchise-hub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/franchise-hub")>()
  return {
    ...actual,
    fetchFranchiseHub: vi.fn(async () => ({
      ok: true,
      hub: { league: "NBA", team_slug: "blazers", team_name: "Portland Trail Blazers", collections: [] },
    })),
  }
})

import { generateMetadata } from "@/app/teams/[league]/[slug]/page"

describe("franchise hub share metadata", () => {
  it("carries the hub's own title, description and URL in openGraph and twitter, with the inherited site fields", async () => {
    const meta: any = await generateMetadata({ params: Promise.resolve({ league: "nba", slug: "blazers" }) })
    const canonical = meta.alternates?.canonical
    expect(canonical).toMatch(/\/teams\/nba\/blazers$/)

    expect(meta.openGraph?.title).toMatch(/Portland Trail Blazers Collectibles Hub/)
    expect(meta.openGraph?.url).toBe(canonical)
    expect(meta.openGraph?.siteName).toBe("Rip Packs City")
    expect(meta.openGraph?.images?.length).toBeGreaterThan(0)

    expect(meta.twitter?.title).toMatch(/Portland Trail Blazers Collectibles Hub/)
    expect(meta.twitter?.site).toBe("@RipPacksCity")

    // The absence of the false claim: nothing here is the homepage's copy.
    expect(JSON.stringify(meta.openGraph)).not.toMatch(/Intelligence Layer for Flow Collectibles/)
  })

  it("keeps the hub's own robots decision alongside the share block", async () => {
    const meta: any = await generateMetadata({ params: Promise.resolve({ league: "nba", slug: "blazers" }) })
    expect(meta.robots).toBeDefined()
  })
})
