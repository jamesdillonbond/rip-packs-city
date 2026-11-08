// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// Sharing ONE challenge entry (2026-11-07, Trevor: "Is there a way for users to
// have a link to share their dame time trophy cases?" — there was not: a Dame
// Time case lived only half-way down /profile/<u>, and a pasted link unfurled
// as the generic profile card).
//
// Now: /profile/<u>/trophy-case/<slug> is that entry's own page, with its own
// card at /api/og/trophy-case/<u>?case=<slug>. The property that matters most:
// ⚠ NEVER SUBSTITUTE — a missing/unread entry is never answered with the
// collector's MAIN case wearing the challenge's name.
// ─────────────────────────────────────────────────────────────────────────────

const getPublicProfile = vi.fn()
vi.mock("@/lib/profile/public-profile", () => ({ getPublicProfile: (...a: unknown[]) => getPublicProfile(...a) }))
const getPublicChallengeCase = vi.fn()
vi.mock("@/lib/trophy/public-challenge-case", async (orig) => ({
  ...(await orig<typeof import("@/lib/trophy/public-challenge-case")>()),
  getPublicChallengeCase: (...a: unknown[]) => getPublicChallengeCase(...a),
}))
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
vi.mock("next/navigation", () => ({ notFound: () => notFound() }))
const artUrls: string[][] = []
vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUriSlots: async (urls: (string | null)[]) => {
    artUrls.push(urls.map(String))
    return urls.map(() => null)
  },
}))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

import { pickChallengeEntry } from "@/lib/trophy/public-challenge-case"
import { challengeCaseOgPath, challengeCaseSharePath, isChallengeSlug } from "@/lib/trophy/challenge-link"
import ChallengeCasePage from "@/app/profile/[username]/trophy-case/[challenge]/page"
import { generateMetadata } from "@/app/profile/[username]/trophy-case/[challenge]/layout"
import { challengeCaseDescription, titleFromSlug } from "@/app/profile/[username]/trophy-case/[challenge]/shared"
import { GET as ogGET } from "@/app/api/og/trophy-case/[username]/route"
import ShareProfileButtons from "@/components/profile/ShareProfileButtons"

const DAME = { slug: "dame-time", title: "Dame Time", tagline: null }
const slab = (slot: number, thumb = `https://img/dame${slot}.png`) => ({
  slot,
  moment_id: "m" + slot,
  player_name: "Damian Lillard",
  thumbnail_url: thumb,
  collection_slug: "nba_top_shot",
})
const profileOk = {
  ok: true as const,
  data: {
    username: "trev",
    bio: { display_name: "Trev", accent_color: null, equipped_border: null },
    trophies: [slab(1, "https://img/MAIN1.png"), slab(2, "https://img/MAIN2.png")],
    wallets: [],
  },
}
const entry = { caseId: "c1", challenge: DAME, slabs: [slab(1), slab(3)] }
const params = (challenge = "dame-time", username = "trev") => ({ params: Promise.resolve({ username, challenge }) })

beforeEach(() => {
  getPublicProfile.mockReset().mockResolvedValue(profileOk)
  getPublicChallengeCase.mockReset().mockResolvedValue({ ok: true, entry })
  notFound.mockClear()
  artUrls.length = 0
})
afterEach(() => cleanup())

describe("helpers", () => {
  it("the share path and card path name the collector AND the challenge", () => {
    expect(challengeCaseSharePath("trev", "dame-time")).toBe("/profile/trev/trophy-case/dame-time")
    expect(challengeCaseOgPath("trev", "dame-time")).toBe("/api/og/trophy-case/trev?case=dame-time")
  })
  it("slug check matches the DB constraint", () => {
    expect(isChallengeSlug("dame-time")).toBe(true)
    expect(isChallengeSlug("Dame-Time")).toBe(false)
    expect(isChallengeSlug("dame--time")).toBe(false)
    expect(isChallengeSlug("../x")).toBe(false)
  })
  it("pickChallengeEntry takes THIS challenge's case, slot-ordered — never a named case or another challenge", () => {
    const cases = [
      { id: "n1", name: "Blazers", challenge: null, slabs: [slab(1)] },
      { id: "o1", challenge: { slug: "other", title: "Other" }, slabs: [slab(1)] },
      { id: "c1", challenge: { slug: "dame-time", title: "Dame Time" }, slabs: [slab(4), slab(2)] },
    ]
    const e = pickChallengeEntry(cases, "dame-time")!
    expect(e.caseId).toBe("c1")
    expect(e.slabs.map((s) => s.slot)).toEqual([2, 4])
    expect(pickChallengeEntry(cases.slice(0, 2), "dame-time")).toBeNull()
    expect(pickChallengeEntry(null, "dame-time")).toBeNull()
  })
  it("the description never publishes a zero", () => {
    expect(challengeCaseDescription({ displayName: "Trev", title: "Dame Time", filled: 3 })).toMatch(/^3 of 6 Dame Time/)
    for (const filled of [0, null]) {
      const d = challengeCaseDescription({ displayName: "Trev", title: "Dame Time", filled })
      expect(d).not.toMatch(/\b0\b/)
      expect(d).toContain("Dame Time")
    }
    expect(titleFromSlug("dame-time")).toBe("Dame Time")
  })
})

describe("the share page", () => {
  it("renders the ENTRY's slabs under the challenge's title", async () => {
    const el: any = await ChallengeCasePage(params())
    expect(el.props.trophies.map((t: any) => t.thumbnail_url)).toEqual(["https://img/dame1.png", "https://img/dame3.png"])
    expect(el.props.challenge).toEqual({ slug: "dame-time", title: "Dame Time" })
    expect(el.props.readFailed).toBe(false)
  })
  it("⚠ a FAILED entry read is a notice — never the main case, never a 404", async () => {
    getPublicChallengeCase.mockResolvedValue({ ok: false })
    const el: any = await ChallengeCasePage(params())
    expect(el.props.readFailed).toBe(true)
    expect(el.props.trophies).toEqual([])
    expect(JSON.stringify(el.props)).not.toContain("MAIN")
    expect(notFound).not.toHaveBeenCalled()
  })
  it("404s only on an ANSWER: no entry in this challenge, no such collector, or a junk slug", async () => {
    getPublicChallengeCase.mockResolvedValue({ ok: true, entry: null })
    await expect(ChallengeCasePage(params())).rejects.toThrow("NEXT_NOT_FOUND")
    getPublicChallengeCase.mockResolvedValue({ ok: true, entry })
    getPublicProfile.mockResolvedValue({ ok: false, status: 404 })
    await expect(ChallengeCasePage(params())).rejects.toThrow("NEXT_NOT_FOUND")
    getPublicProfile.mockResolvedValue(profileOk)
    await expect(ChallengeCasePage(params("../etc"))).rejects.toThrow("NEXT_NOT_FOUND")
  })
})

describe("its link preview", () => {
  it("points at its OWN card and canonical — not the main case's", async () => {
    const m: any = await generateMetadata(params())
    expect(m.alternates.canonical).toMatch(/\/profile\/trev\/trophy-case\/dame-time$/)
    expect(m.openGraph.url).toBe(m.alternates.canonical)
    expect(m.openGraph.images[0].url).toMatch(/\/api\/og\/trophy-case\/trev\?case=dame-time$/)
    expect(m.twitter.images[0].url).toBe(m.openGraph.images[0].url)
    expect(m.title.absolute).toBe("Trev's Dame Time Trophy Case | Rip Packs City")
    expect(m.description).toMatch(/^2 of 6 Dame Time pieces/)
  })
  it("no entry → not-found metadata (noindex, no card)", async () => {
    getPublicChallengeCase.mockResolvedValue({ ok: true, entry: null })
    const m: any = await generateMetadata(params())
    expect(m.robots).toEqual({ index: false, follow: true })
    expect(m.openGraph).toBeUndefined()
  })
})

describe("its social card", () => {
  const og = (q: string) =>
    ogGET(new NextRequest("https://x/api/og/trophy-case/trev" + q), { params: Promise.resolve({ username: "trev" }) })

  it("?case= draws the ENTRY's Moments", async () => {
    await og("?case=dame-time")
    expect(artUrls.flat().join(" ")).toContain("dame1")
    expect(artUrls.flat().join(" ")).not.toContain("MAIN")
  })
  it("⚠ NEVER SUBSTITUTES: no entry / unread entry / junk slug → the fallback, not the main case", async () => {
    for (const r of [{ ok: true, entry: null }, { ok: false }]) {
      getPublicChallengeCase.mockResolvedValue(r)
      artUrls.length = 0
      const res = await og("?case=dame-time")
      expect(res.status).toBe(200)
      expect(artUrls.flat().join(" ")).not.toContain("MAIN")
    }
    artUrls.length = 0
    await og("?case=..%2Fx")
    expect(artUrls.flat().join(" ")).not.toContain("MAIN")
  })
  it("without ?case= it is still the main case's card", async () => {
    await og("")
    expect(artUrls.flat().join(" ")).toContain("MAIN1")
  })
})

describe("the share buttons", () => {
  let writeText: ReturnType<typeof vi.fn>
  let open: ReturnType<typeof vi.fn>
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    open = vi.fn()
    vi.stubGlobal("open", open)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("copy + X share the ENTRY's page (not /trophy-case, not the profile) and name the challenge", async () => {
    render(<ShareProfileButtons username="trev" surface="trophy-case" challenge={{ slug: "dame-time", title: "Dame Time" }} trophyCount={4} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(String(writeText.mock.calls[0][0])).toMatch(/\/profile\/trev\/trophy-case\/dame-time$/)
    fireEvent.click(screen.getByRole("button", { name: "Share on X" }))
    const intent = decodeURIComponent(String(open.mock.calls[0][0]))
    expect(intent).toMatch(/\/profile\/trev\/trophy-case\/dame-time$/)
    expect(intent).not.toMatch(/utm_|ref=/)
    expect(intent).toContain("My Dame Time trophy case on @RipPacksCity — 4 of 6 filled")
  })
})
