import { describe, it, expect, vi, beforeEach } from "vitest"

// A trophy challenge's own link preview (2026-11-07, Trevor: challenges "should
// have their own special link preview"). Three parts: the crawler routing, the
// card's data + copy (never a zero we did not read), and the board's metadata
// pointing at its own card.

import { challengePreviewTarget, isLinkPreviewBot } from "@/lib/routing/link-preview-bot"
import { challengeDescription } from "@/lib/trophy/challenge-copy"

const rpc = vi.fn()
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) }, supabaseAdmin: {} }))
const artUrls: string[][] = []
vi.mock("@/lib/og/img-data", () => ({
  ogImageDataUriSlots: async (urls: (string | null)[]) => {
    artUrls.push(urls.map(String))
    return urls.map(() => "data:image/png;base64,AAAA")
  },
}))

import { challengeCardData, entryLine, renderChallengeCard } from "@/app/api/og/trophy-challenge/[slug]/route"
import { generateMetadata } from "@/app/trophy-challenges/[slug]/page"

const payload = (n: number) => ({
  challenge: { title: "Dame Time", tagline: "Six Dame pieces." },
  entry_count: n,
  entries: Array.from({ length: n }, (_, i) => ({
    username: "c" + i,
    slabs: [
      { slot: 2, thumbnail_url: `https://img/c${i}-s2.png`, tier: "RARE" },
      { slot: 1, thumbnail_url: `https://img/c${i}-s1.png`, tier: "LEGENDARY" },
    ],
  })),
})

beforeEach(() => {
  rpc.mockReset()
  artUrls.length = 0
})

describe("crawler routing", () => {
  it("only link-preview crawlers, only /dashboard, only a valid challenge", () => {
    const D = "Mozilla/5.0 (compatible; Discordbot/2.0)"
    expect(isLinkPreviewBot(D)).toBe(true)
    expect(isLinkPreviewBot("Twitterbot/1.0")).toBe(true)
    expect(isLinkPreviewBot("Mozilla/5.0 (Macintosh) Safari/605")).toBe(false)
    expect(challengePreviewTarget("/dashboard", "?tab=trophy&challenge=dame-time", D)).toBe("/trophy-challenges/dame-time")
    expect(challengePreviewTarget("/dashboard", "?tab=trophy&challenge=dame-time", "Safari")).toBeNull()
    expect(challengePreviewTarget("/dashboard", "?tab=trophy", D)).toBeNull()
    expect(challengePreviewTarget("/dashboard/packs", "?challenge=dame-time", D)).toBeNull()
    expect(challengePreviewTarget("/dashboard", "?challenge=../x", D)).toBeNull()
  })
})

describe("the card", () => {
  it("takes one piece per entry (the lowest slot), at most six, and the true entry count", () => {
    const c = challengeCardData({ ...payload(8), entry_count: 8 })
    expect(c.kind).toBe("ok")
    if (c.kind !== "ok") return
    expect(c.entries).toHaveLength(6)
    expect(c.entries[0].slab?.thumbnail_url).toBe("https://img/c0-s1.png")
    expect(c.entryCount).toBe(8)
  })
  it("an unknown challenge is `missing`; an unreadable payload is `failed` — neither draws a count", () => {
    expect(challengeCardData(null).kind).toBe("missing")
    expect(challengeCardData({ entries: [] }).kind).toBe("failed")
  })
  it("the entry line invites at a READ zero and never says '0 collectors'", () => {
    expect(entryLine(0)).toBe("No entries yet — be the first")
    expect(entryLine(1)).toBe("1 collector entered")
    expect(entryLine(5)).toBe("5 collectors entered")
  })
  it("renders the entries' art and is stored only as a FULL card", async () => {
    rpc.mockResolvedValue({ data: payload(3), error: null })
    const res = await renderChallengeCard("dame-time")
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-og-card")).toBe("full")
    expect(artUrls.flat().join(" ")).toContain("c0-s1")
  })
  it("⚠ a FAILED read draws the neutral fallback — not marked full, so never stored", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout", code: "57014" } })
    const res = await renderChallengeCard("dame-time")
    expect(res.headers.get("x-og-card")).toBeNull()
    expect(artUrls).toHaveLength(0)
  })
})

describe("the board's preview metadata", () => {
  it("points at the challenge's OWN card, canonical and twitter alike", async () => {
    rpc.mockResolvedValue({ data: payload(4), error: null })
    const m: any = await generateMetadata({ params: Promise.resolve({ slug: "dame-time" }) })
    expect(m.openGraph.images[0].url).toBe("https://www.rippackscity.com/api/og/trophy-challenge/dame-time")
    expect(m.twitter.images[0].url).toBe(m.openGraph.images[0].url)
    expect(m.twitter.card).toBe("summary_large_image")
    expect(m.openGraph.url).toBe(m.alternates.canonical)
    expect(m.description).toBe("Six Dame pieces. 4 collectors have entered — show off your six on Rip Packs City.")
  })
  it("the description never publishes a zero it did not read", () => {
    expect(challengeDescription({ tagline: "Six Dame pieces.", entryCount: null })).not.toMatch(/\b0\b/)
    expect(challengeDescription({ tagline: null, entryCount: 0 })).toContain("be the first")
  })
})
