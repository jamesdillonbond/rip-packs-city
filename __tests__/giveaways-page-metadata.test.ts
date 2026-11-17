import { describe, it, expect, vi } from "vitest"

// The giveaway page unfurls with its OWN card (2026-11-10, Dame Time on X).
const meta = vi.hoisted(() => ({ value: null as { title: string; gated: boolean } | null }))
vi.mock("@/lib/giveaways/drop-meta", () => ({ giveawayMeta: async () => meta.value }))
vi.mock("@/components/GlobalSiteHeader", () => ({ default: () => null }))
vi.mock("@/components/SkipToContent", () => ({ PageContentAnchor: () => null }))
vi.mock("@/components/SiteFooter", () => ({ default: () => null }))
vi.mock("@/app/giveaways/[slug]/GiveawayClient", () => ({ default: () => null }))
import { generateMetadata } from "@/app/giveaways/[slug]/page"

const md = (slug: string) => generateMetadata({ params: Promise.resolve({ slug }) })

describe("giveaway page metadata", () => {
  it("a named, gated drop: its title, the finisher copy, and the giveaway card on og AND twitter (summary_large_image)", async () => {
    meta.value = { title: "Dame Time Challenge Reward Pack", gated: true }
    const m = await md("dame-time-challenge-reward-pack")
    expect(m.title).toBe("Dame Time Challenge Reward Pack")
    expect(String(m.description)).toMatch(/completed the challenge/)
    const img = "https://www.rippackscity.com/api/og/giveaway/dame-time-challenge-reward-pack"
    expect(JSON.stringify(m.openGraph)).toContain(img)
    expect(JSON.stringify(m.twitter)).toContain(img)
    expect((m.twitter as { card?: string }).card).toBe("summary_large_image")
    expect(m.robots).toEqual({ index: false, follow: false })
  })

  it("an unread or unknown drop: the generic title — never a drop that may not exist — still with the card", async () => {
    meta.value = null
    const m = await md("nope-drop")
    expect(m.title).toBe("Free pack giveaway")
    expect(JSON.stringify(m.openGraph)).toContain("/api/og/giveaway/nope-drop")
  })
})
