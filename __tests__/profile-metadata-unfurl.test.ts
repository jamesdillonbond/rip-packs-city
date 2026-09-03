import { describe, it, expect, vi, beforeEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// The /profile/<username> LINK PREVIEW.
//
// Nothing else in the suite asserted what `generateMetadata` emits for any
// page, which is how this file shipped for two months publishing
// "Portfolio: $0 FMV across 0 moments" about real, named collectors whenever
// its read failed. The OG image had already been fixed for exactly this
// (commit 8371cfdf, `walletsOk ? fmtDollars(total) : "—"`); the description
// string lived in a different file and was left behind.
//
// So the assertions below are split deliberately:
//   • profileDescription() — the honesty rule, three states not two.
//   • generateMetadata()   — the card CONTRACT, because Next replaces
//     `openGraph`/`twitter` wholesale rather than merging them, and a partial
//     object silently drops siteName / creator / type from lib/seo.ts.
// ─────────────────────────────────────────────────────────────────────────────

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: (...a: unknown[]) => getPublicProfile(...a),
}))

import { generateMetadata, profileDescription } from "@/app/profile/[username]/layout"

const okPayload = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: {
    username: "trevor",
    bio: { display_name: "Trevor", tagline: null },
    trophies: [{ slot: 1 }, { slot: 2 }],
    wallets: [{ cached_fmv: 1500, cached_moment_count: 200 }],
    ...over,
  },
})

const meta = (u = "trevor") =>
  generateMetadata({ params: Promise.resolve({ username: u }) }) as Promise<any>

beforeEach(() => {
  getPublicProfile.mockReset()
})

describe("profileDescription — never emits a zero", () => {
  it("reports every figure it was given", () => {
    const d = profileDescription({ totalFmv: 1500, momentCount: 200, trophyCount: 2 })
    expect(d).toContain("$1.5K portfolio")
    expect(d).toContain("200 Moments")
    expect(d).toContain("2 trophy Moments on display")
  })

  // The invariant, stated three ways. Dropping ANY of the `> 0` guards reds at
  // least one of these — which is the point: the honesty rule is carried by
  // code a mutation can break, not by a flag that cannot change the output.
  it.each([
    ["nothing at all", { totalFmv: 0, momentCount: 0, trophyCount: 0 }],
    ["no portfolio", { totalFmv: 0, momentCount: 12, trophyCount: 1 }],
    ["no moments", { totalFmv: 40, momentCount: 0, trophyCount: 1 }],
    ["no trophies", { totalFmv: 40, momentCount: 12, trophyCount: 0 }],
  ])("suppresses an absent total rather than publishing it as zero (%s)", (_l, input) => {
    const d = profileDescription(input)
    expect(d).not.toMatch(/\$0\b/)
    expect(d).not.toMatch(/\b0 Moments?\b/)
    expect(d).not.toMatch(/\b0 trophy\b/)
  })

  it("falls back to describing the surface when it has no figure at all", () => {
    // "$0 FMV across 0 moments" reads as a valuation OF THE PERSON rather than
    // an absence of data — the string that actually shipped.
    const d = profileDescription({ totalFmv: 0, momentCount: 0, trophyCount: 0 })
    expect(d).toMatch(/Trophy case/i)
  })

  it("still reports the parts it does have", () => {
    const d = profileDescription({ totalFmv: 0, momentCount: 0, trophyCount: 3 })
    expect(d).toContain("3 trophy Moments on display")
  })

  it("singularises", () => {
    const d = profileDescription({ totalFmv: 12, momentCount: 1, trophyCount: 1 })
    expect(d).toContain("1 Moment ")
    expect(d).toContain("1 trophy Moment on display")
  })

  it("never tells a social platform the data is unavailable", () => {
    // An unfurl is cached for days; an outage notice would outlive the outage.
    for (const d of [
      profileDescription({ totalFmv: 0, momentCount: 0, trophyCount: 0 }),
      profileDescription({ totalFmv: 5, momentCount: 1, trophyCount: 0 }),
    ]) {
      expect(d).not.toMatch(/unavailable|couldn't|could not|error|try again/i)
    }
  })
})

describe("generateMetadata — the card contract", () => {
  it("restates every root field Next would otherwise drop", async () => {
    getPublicProfile.mockResolvedValue(okPayload())
    const m = await meta()

    // openGraph/twitter are REPLACED, not merged. If these regress the unfurl
    // loses its site attribution while still looking fine locally.
    expect(m.openGraph.siteName).toBe("Rip Packs City")
    expect(m.openGraph.type).toBe("profile")
    expect(m.openGraph.url).toContain("/profile/trevor")
    expect(m.twitter.card).toBe("summary_large_image")
    expect(m.twitter.site).toMatch(/^@/)
    expect(m.twitter.creator).toMatch(/^@/)
  })

  it("describes the portfolio net of stale-priced value, like the page and the card (QA #6)", async () => {
    getPublicProfile.mockResolvedValue(
      okPayload({ wallets: [{ cached_fmv: 88425, cached_fmv_stale: 39553, cached_moment_count: 19381 }] }),
    )
    const m = await meta()
    expect(String(m.description)).toContain("$48.9K")
    expect(String(m.description)).not.toContain("$88.4K")
  })

  it("ships alt text and explicit dimensions on the image", async () => {
    getPublicProfile.mockResolvedValue(okPayload())
    const m = await meta()
    expect(m.openGraph.images[0]).toMatchObject({ width: 1200, height: 630 })
    expect(m.openGraph.images[0].alt).toBeTruthy()
    expect(m.twitter.images[0].alt).toBeTruthy()
  })

  it("points the image at the profile's own OG card and sets a canonical", async () => {
    getPublicProfile.mockResolvedValue(okPayload())
    const m = await meta()
    expect(m.openGraph.images[0].url).toContain("/api/og/profile/trevor")
    expect(m.alternates.canonical).toContain("/profile/trevor")
  })

  it("withholds figures when the read errors, and does not throw", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 500, error: "boom" })
    const m = await meta()
    expect(m.description).not.toMatch(/\$/)
    // Never leak the driver's own message into a public meta tag.
    expect(m.description).not.toContain("boom")
  })

  it("survives a thrown read rather than failing the whole page render", async () => {
    getPublicProfile.mockRejectedValue(new Error("pool timeout"))
    const m = await meta()
    expect(m.title.absolute).toContain("Rip Packs City")
    expect(m.description).not.toMatch(/\$/)
    expect(m.description).not.toContain("pool timeout")
  })

  it("noindexes a username that resolves to nothing", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 404, error: "Not found" })
    const m = await meta()
    expect(m.robots).toMatchObject({ index: false })
  })

  it("leaves a REAL profile indexable", async () => {
    // The mirror assertion — a noindex that fires too widely would quietly
    // de-list every collector profile in the sitemap.
    getPublicProfile.mockResolvedValue(okPayload())
    const m = await meta()
    expect(m.robots).toBeUndefined()
  })

  it("does not noindex on a failed read either", async () => {
    // A 500 is transient; de-indexing a real profile over one is worse than the
    // missing figures it already causes.
    getPublicProfile.mockResolvedValue({ ok: false, status: 500, error: "boom" })
    const m = await meta()
    expect(m.robots).toBeUndefined()
  })

  it("prefers the display name but falls back to the handle", async () => {
    getPublicProfile.mockResolvedValue(okPayload({ bio: { display_name: null } }))
    const m = await meta()
    expect(m.title.absolute).toContain("trevor")
  })

  it("reads the shared module with the page's own source label", async () => {
    getPublicProfile.mockResolvedValue(okPayload())
    await meta()
    expect(getPublicProfile).toHaveBeenCalledWith("trevor", "ssr")
  })
})
