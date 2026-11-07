import { describe, it, expect, vi, beforeEach } from "vitest"

// The page half of trophy-challenge-page-404s-only-on-a-successful-empty-read
// (split out: vi.mock is hoisted per FILE, and the probe tests need the real
// probe). /trophy-challenges/<slug> calls notFound() ONLY when the probe says
// 'missing' — a successful read that returned NULL; a failed probe renders.

const probeMock = vi.fn()
const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
vi.mock("@/lib/trophy/challenge-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/trophy/challenge-probe")>()),
  probeTrophyChallengeLive: (...a: unknown[]) => probeMock(...a),
}))
vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }))
vi.mock("@/components/GlobalSiteHeader", () => ({ default: () => null }))
vi.mock("@/components/SiteFooter", () => ({ default: () => null }))
vi.mock("@/components/SkipToContent", () => ({ PageContentAnchor: () => null }))
vi.mock("@/app/trophy-challenges/[slug]/ChallengeBoardClient", () => ({ default: () => null }))

describe("/trophy-challenges/[slug] page", () => {
  beforeEach(() => {
    probeMock.mockReset()
    notFoundMock.mockClear()
  })

  it("an unknown slug is a real 404", async () => {
    probeMock.mockResolvedValue({ kind: "missing" })
    const { default: Page } = await import("@/app/trophy-challenges/[slug]/page")
    await expect(Page({ params: Promise.resolve({ slug: "no-such-1" }) })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(notFoundMock).toHaveBeenCalledTimes(1)
  })

  it("a FAILED probe still renders the board (never a 404)", async () => {
    probeMock.mockResolvedValue({ kind: "unknown" })
    const { default: Page } = await import("@/app/trophy-challenges/[slug]/page")
    const el = await Page({ params: Promise.resolve({ slug: "dame-time-2" }) })
    expect(el).toBeTruthy()
    expect(notFoundMock).not.toHaveBeenCalled()
  })

  it("a found challenge renders and names itself in <title>", async () => {
    probeMock.mockResolvedValue({ kind: "found", title: "Dame Time", tagline: null })
    const { default: Page, generateMetadata } = await import("@/app/trophy-challenges/[slug]/page")
    const el = await Page({ params: Promise.resolve({ slug: "dame-time-3" }) })
    expect(el).toBeTruthy()
    expect(notFoundMock).not.toHaveBeenCalled()
    const md = await generateMetadata({ params: Promise.resolve({ slug: "dame-time-3" }) })
    expect(md.title).toBe("Dame Time · Trophy case challenge")
    expect(md.robots).toEqual({ index: false, follow: true })
  })

  it("a failed probe leaves the generic title (no fabricated name)", async () => {
    probeMock.mockResolvedValue({ kind: "unknown" })
    const { generateMetadata } = await import("@/app/trophy-challenges/[slug]/page")
    const md = await generateMetadata({ params: Promise.resolve({ slug: "dame-time-4" }) })
    expect(md.title).toBe("Trophy case challenge")
  })

  it("an unknown slug's metadata names no canonical / og (it streams into the 404's head)", async () => {
    probeMock.mockResolvedValue({ kind: "missing" })
    const { generateMetadata } = await import("@/app/trophy-challenges/[slug]/page")
    const md = await generateMetadata({ params: Promise.resolve({ slug: "no-such-5" }) })
    expect(md.alternates ?? null).toBeNull()
    expect(md.openGraph ?? null).toBeNull()
    expect(md.robots).toEqual({ index: false, follow: false })
  })

  it("a failed probe keeps the canonical (the page renders; absence is not known)", async () => {
    probeMock.mockResolvedValue({ kind: "unknown" })
    const { generateMetadata } = await import("@/app/trophy-challenges/[slug]/page")
    const md = await generateMetadata({ params: Promise.resolve({ slug: "dame-time-6" }) })
    expect(md.alternates).toEqual({ canonical: "https://www.rippackscity.com/trophy-challenges/dame-time-6" })
  })
})
