import { describe, it, expect, vi, beforeEach } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// /profile/<username>/trophy-case — the shareable trophy case.
//
// Until 2026-08-14 the only trophy-case export was a PDF, and a PDF cannot
// unfurl: pasting one into X or Discord produces a file, not a picture. The
// profile card does show the case but LEADS WITH PORTFOLIO FMV, so it answers
// "how big is this collection" when sharing a case asks "look at these six".
//
// The assertions are the two properties that make this surface safe to share:
// it never publishes a figure the read did not produce, and it never turns our
// outage into a claim about the collector.
// ─────────────────────────────────────────────────────────────────────────────

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: (...a: unknown[]) => getPublicProfile(...a),
}))

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
vi.mock("next/navigation", () => ({ notFound: () => notFound() }))

import {
  generateMetadata,
  trophyCaseDescription,
} from "@/app/profile/[username]/trophy-case/layout"
import { caseTileWidth } from "@/app/api/og/trophy-case/[username]/route"

const ok = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: {
    username: "trevor",
    bio: { display_name: "Trevor", accent_color: "#E03A2F", equipped_border: null },
    trophies: [{ slot: 1 }, { slot: 2 }, { slot: 3 }],
    wallets: [],
    ...over,
  },
})

const meta = (u = "trevor") =>
  generateMetadata({ params: Promise.resolve({ username: u }) }) as Promise<any>

beforeEach(() => {
  getPublicProfile.mockReset()
  notFound.mockClear()
})

describe("trophyCaseDescription — never emits a zero", () => {
  it("counts the pinned Moments", () => {
    const d = trophyCaseDescription({ displayName: "Trevor", trophyCount: 3 })
    expect(d).toContain("3 trophy Moments")
    expect(d).toContain("Trevor")
  })

  it("singularises", () => {
    expect(trophyCaseDescription({ displayName: "T", trophyCount: 1 })).toContain(
      "1 trophy Moment ",
    )
  })

  it("suppresses the count rather than publishing '0 trophy Moments'", () => {
    // Zero is ambiguous between "empty case" and "we could not read it", and
    // the reader cannot tell — same rule as the profile unfurl description.
    const d = trophyCaseDescription({ displayName: "Trevor", trophyCount: 0 })
    expect(d).not.toMatch(/\b0 trophy\b/)
    expect(d).toContain("Trevor")
  })
})

describe("trophy-case unfurl", () => {
  it("carries the full card contract", async () => {
    getPublicProfile.mockResolvedValue(ok())
    const m = await meta()
    expect(m.openGraph.siteName).toBe("Rip Packs City")
    expect(m.openGraph.type).toBe("profile")
    expect(m.twitter.card).toBe("summary_large_image")
    expect(m.twitter.site).toMatch(/^@/)
    expect(m.twitter.creator).toMatch(/^@/)
    expect(m.openGraph.images[0]).toMatchObject({ width: 1200, height: 630 })
    expect(m.openGraph.images[0].alt).toBeTruthy()
  })

  it("points at its OWN card, not the profile card", async () => {
    // The whole reason this surface exists: a different picture, leading with
    // the Moments instead of a portfolio total.
    getPublicProfile.mockResolvedValue(ok())
    const m = await meta()
    expect(m.openGraph.images[0].url).toContain("/api/og/trophy-case/trevor")
    expect(m.openGraph.images[0].url).not.toContain("/api/og/profile/")
  })

  it("canonicalises to the trophy-case URL and matches og:url", async () => {
    getPublicProfile.mockResolvedValue(ok())
    const m = await meta()
    expect(m.alternates.canonical).toContain("/profile/trevor/trophy-case")
    expect(m.openGraph.url).toBe(m.alternates.canonical)
  })

  it("publishes no figure when the read fails, and does not throw", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 500, error: "boom" })
    const m = await meta()
    expect(m.description).not.toMatch(/\b0 trophy\b/)
    expect(m.description).not.toContain("boom")
  })

  it("survives a thrown read", async () => {
    getPublicProfile.mockRejectedValue(new Error("pool timeout"))
    const m = await meta()
    expect(m.title.absolute).toContain("Rip Packs City")
    expect(m.description).not.toContain("pool timeout")
  })

  it("noindexes a handle that resolves to nothing, but not a transient failure", async () => {
    getPublicProfile.mockResolvedValue({ ok: false, status: 404, error: "Not found" })
    expect((await meta()).robots).toMatchObject({ index: false })

    getPublicProfile.mockResolvedValue({ ok: false, status: 500, error: "boom" })
    expect((await meta()).robots).toBeUndefined()

    getPublicProfile.mockResolvedValue(ok())
    expect((await meta()).robots).toBeUndefined()
  })

  it("shares the page shell's memoized read", async () => {
    getPublicProfile.mockResolvedValue(ok())
    await meta()
    expect(getPublicProfile).toHaveBeenCalledWith("trevor", "ssr")
  })
})

describe("caseTileWidth — one row, filling the canvas at every count", () => {
  it("fits the 1104px content box for 1..6 tiles", () => {
    for (let n = 1; n <= 6; n++) {
      const w = caseTileWidth(n)
      expect(n * w + (n - 1) * 12).toBeLessThanOrEqual(1104)
    }
  })

  it("keeps every tile taller than the profile card's, which is the point", () => {
    // A dedicated card that renders the Moments SMALLER than the card it is
    // meant to improve on would be pure duplication. The profile card's widest
    // multi-tile size is 130px at 3-up.
    for (let n = 1; n <= 6; n++) {
      expect(caseTileWidth(n)).toBeGreaterThan(130)
    }
  })

  it("fits the vertical space at the largest tile", () => {
    expect(Math.round(caseTileWidth(1) * 1.32)).toBeLessThanOrEqual(400)
  })

  it("scales down monotonically as tiles are added", () => {
    for (let n = 2; n <= 6; n++) {
      expect(caseTileWidth(n)).toBeLessThan(caseTileWidth(n - 1))
    }
  })

  it("clamps a nonsense count instead of returning undefined", () => {
    expect(caseTileWidth(0)).toBeGreaterThan(0)
    expect(caseTileWidth(99)).toBe(caseTileWidth(6))
  })
})
