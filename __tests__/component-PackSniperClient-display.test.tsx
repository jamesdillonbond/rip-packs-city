// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import type { Deal } from "@/app/insights/pack-sniper/PackSniperClient"
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"

// The sibling suite drives this board's BEHAVIOUR — which tab refetches, which
// filter narrows the set, which sorter runs. What stayed dark (68 uncovered
// branches, the largest gap left in the component gate) is the layer that
// decides what each row CLAIMS: the recency chips, the KPI median, and the
// magnitude ladders. Their failure mode is a wrong number or a false badge on a
// public deal board, not a crash — so nothing above them can catch it.
//
// The load-bearing one is the AT 24H LOW chip. The component's own comment says
// it is gated on `lowAsk7d < lowestAsk` so it "stays hidden at cold start (when
// the rolling-low buckets all equal the live ask) and only appears once the
// trend cron has accumulated genuinely-cheaper history". Drop that guard and
// every pack wears AT 24H LOW on the day a collection is onboarded — a scarcity
// signal asserted about packs whose price history we have not yet observed.

const deal = (o: Partial<Deal> = {}): Deal => ({
  distId: "d1", title: "Base Series Pack", tier: "common", imageUrl: "", slots: 5,
  lowestAsk: 20, grossEV: 40, liveValueRatio: 2, discountPct: 50, fmvCoveragePct: 90,
  evSnapshottedAt: "2026-08-01T00:00:00Z", editionCount: 100, depletionPct: 40,
  highVariance: false, highVarianceReasons: [], buyUrl: "https://buy", dapperUrl: "https://dapper",
  detailHref: "/x", simulatorHref: "/y", askChangedAt: null, askFirstSeenAt: null, prevAsk: null,
  isNew: false, isPriceDrop: false, askDropPct: null, lowAsk24h: null, lowAsk7d: null, atLow24h: false, ...o,
})

let fetchFn: ReturnType<typeof vi.fn>

/** Mount with an exact deal set; the board always refetches on mount. */
function mount(rows: Deal[]) {
  fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ meta: { fetched_at: "2026-08-02T00:00:00Z", collection: "nba-top-shot" }, deals: rows }),
  }))
  vi.stubGlobal("fetch", fetchFn)
  return render(<PackSniperClient initialDeals={rows} initialFetchedAt="2026-08-02T00:00:00Z" />)
}

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("AT 24H LOW is gated so it cannot fire at cold start", () => {
  it("shows the chip when the 7d low really is below the live ask", async () => {
    const { findByText } = mount([deal({ atLow24h: true, lowestAsk: 20, lowAsk7d: 15 })])
    expect(await findByText("AT 24H LOW")).toBeTruthy()
  })

  it("HIDES it when lowAsk7d EQUALS the live ask — the cold-start case", async () => {
    // Before the trend cron has any history, every rolling-low bucket equals
    // the live ask. Rendering the chip then claims a low we have not observed.
    const { container, findByText } = mount([
      deal({ atLow24h: true, lowestAsk: 20, lowAsk7d: 20, title: "Cold Start Pack" }),
    ])
    await findByText("Cold Start Pack")
    expect(container.textContent).not.toContain("AT 24H LOW")
  })

  it("HIDES it when lowAsk7d is null, even with atLow24h set", async () => {
    const { container, findByText } = mount([
      deal({ atLow24h: true, lowAsk7d: null, title: "No History Pack" }),
    ])
    await findByText("No History Pack")
    expect(container.textContent).not.toContain("AT 24H LOW")
  })

  it("HIDES it when atLow24h is false even though 7d history is cheaper", async () => {
    // The two conditions are independent: cheaper history alone does not mean
    // the ask is AT its low right now.
    const { container, findByText } = mount([
      deal({ atLow24h: false, lowestAsk: 20, lowAsk7d: 15, title: "Off Low Pack" }),
    ])
    await findByText("Off Low Pack")
    expect(container.textContent).not.toContain("AT 24H LOW")
  })
})

describe("NEW and the price-drop chip are mutually exclusive", () => {
  it("shows NEW and suppresses the drop chip when both flags are set", async () => {
    // A pack cannot be both newly listed and a drop from its own prior ask;
    // NEW wins, and showing both would double-count one event.
    const { container, findByText } = mount([
      deal({ isNew: true, isPriceDrop: true, askDropPct: 0.2, title: "Fresh Pack" }),
    ])
    await findByText("Fresh Pack")
    expect(container.textContent).toContain("NEW")
    expect(container.textContent).not.toContain("20%")
  })

  it("renders the drop percentage when only isPriceDrop is set", async () => {
    const { findByText } = mount([deal({ isPriceDrop: true, askDropPct: 0.25 })])
    // 0.25 -> "25%", i.e. the fraction is rendered as a percentage exactly once.
    expect(await findByText(/25%/)).toBeTruthy()
  })

  it("falls back to the word 'drop' when the percentage is unknown", async () => {
    // Scoped to the chip: the filter bar also carries the words "price-drop",
    // so a bare text query matches controls rather than the badge under test.
    const { container, findByText } = mount([
      deal({ isPriceDrop: true, askDropPct: null, title: "Unknown Drop Pack" }),
    ])
    await findByText("Unknown Drop Pack")
    const chip = container.querySelector(".rpc-ps-drop-chip")
    expect(chip?.textContent).toContain("drop")
    expect(chip?.textContent).not.toMatch(/%|NaN/)
  })

  it("titles the drop chip with the previous ask when there is one", async () => {
    const { container, findByText } = mount([
      deal({ isPriceDrop: true, askDropPct: 0.1, prevAsk: 250, title: "Dropped Pack" }),
    ])
    await findByText("Dropped Pack")
    const chip = container.querySelector(".rpc-ps-drop-chip")
    expect(chip?.getAttribute("title")).toBe("Dropped from $250")
  })
})

describe("the KPI median is a real median, not a midpoint pick", () => {
  it("averages the two middles on an EVEN-sized set", async () => {
    // ratios 1, 2, 3, 4 -> median 2.5, rendered by fmtRatio as "2.5×".
    // Taking ratios[mid] instead would report 3.0× — a 20% overstatement of the
    // board's typical deal, on a headline KPI.
    const { container, findByText } = mount([
      deal({ distId: "a", liveValueRatio: 1, title: "A" }),
      deal({ distId: "b", liveValueRatio: 2, title: "B" }),
      deal({ distId: "c", liveValueRatio: 3, title: "C" }),
      deal({ distId: "d", liveValueRatio: 4, title: "D" }),
    ])
    await findByText("A")
    expect(container.textContent).toContain("2.5×")
  })

  it("takes the middle on an ODD-sized set", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", liveValueRatio: 1, title: "A" }),
      deal({ distId: "b", liveValueRatio: 2.4, title: "B" }),
      deal({ distId: "c", liveValueRatio: 9, title: "C" }),
    ])
    await findByText("A")
    expect(container.textContent).toContain("2.4×")
  })

  it("reports the best ratio from the top of the sorted ratios, not the first row", async () => {
    // `bestRatio` reads ratios[len-1] off the ASCENDING sort, which is
    // independent of the row order the user chose.
    const { container, findByText } = mount([
      deal({ distId: "a", liveValueRatio: 1, title: "A" }),
      deal({ distId: "b", liveValueRatio: 12, title: "B" }),
      deal({ distId: "c", liveValueRatio: 3, title: "C" }),
    ])
    await findByText("A")
    // fmtRatio: >= 10 renders with no decimals.
    expect(container.textContent).toContain("12×")
  })
})

describe("magnitude ladders", () => {
  it("formats asks across the whole fmtUsd ladder", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", lowestAsk: 12.5, title: "A" }), // < 100 -> 2dp
      deal({ distId: "b", lowestAsk: 250, title: "B" }), // >= 100 -> 0dp
      deal({ distId: "c", lowestAsk: 2500, title: "C" }), // >= 1000 -> 1dp k
      deal({ distId: "d", lowestAsk: 25000, title: "D" }), // >= 10000 -> 0dp k
    ])
    await findByText("A")
    const t = container.textContent ?? ""
    expect(t).toContain("$12.50")
    expect(t).toContain("$250")
    expect(t).toContain("$2.5k")
    expect(t).toContain("$25k")
  })

  it("formats ratios across the whole fmtRatio ladder", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", liveValueRatio: 1.25, title: "A" }), // < 10 -> 1dp
      deal({ distId: "b", liveValueRatio: 42.7, title: "B" }), // >= 10 -> 0dp
      deal({ distId: "c", liveValueRatio: 480, title: "C" }), // >= 100 -> rounded
    ])
    await findByText("A")
    const t = container.textContent ?? ""
    expect(t).toContain("1.3×") // toFixed(1) rounds 1.25
    expect(t).toContain("43×")
    expect(t).toContain("480×")
  })

  it("renders a relative listed time once mounted", async () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString()
    const { findByText } = mount([deal({ askChangedAt: iso })])
    expect(await findByText("3h ago")).toBeTruthy()
  })

  it("renders 'just now' under a minute and days beyond 24h", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", title: "A", askChangedAt: new Date(Date.now() - 5_000).toISOString() }),
      deal({ distId: "b", title: "B", askChangedAt: new Date(Date.now() - 50 * 3600_000).toISOString() }),
    ])
    await findByText("A")
    const t = container.textContent ?? ""
    expect(t).toContain("just now")
    expect(t).toContain("2d ago")
  })

  it("renders NO relative label for a FUTURE askChangedAt", async () => {
    // A clock-skewed upstream timestamp would otherwise produce a negative age
    // and a nonsense label; relTime returns "" rather than guessing.
    const future = new Date(Date.now() + 3600_000).toISOString()
    const { container, findByText } = mount([deal({ askChangedAt: future, title: "Skewed" })])
    await findByText("Skewed")
    expect(container.textContent).not.toMatch(/ago|just now/)
  })
})

describe("tier tabs reflect only the tiers actually loaded, in rarity order", () => {
  it("orders present tiers by rarity and puts an unknown tier last", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", tier: "legendary", title: "A" }),
      deal({ distId: "b", tier: "common", title: "B" }),
      deal({ distId: "c", tier: "mythic", title: "C" }), // not in TIER_RANK -> 99
      deal({ distId: "d", tier: "rare", title: "D" }),
    ])
    await findByText("A")
    const tabs = Array.from(container.querySelectorAll("button"))
      .map((b) => (b.textContent ?? "").trim().toLowerCase())
      .filter((t) => ["common", "rare", "legendary", "mythic"].includes(t))
    expect(tabs).toEqual(["common", "rare", "legendary", "mythic"])
  })

  it("omits a tier that is absent from the loaded set", async () => {
    const { container, findByText } = mount([deal({ tier: "rare", title: "Only Rare" })])
    await findByText("Only Rare")
    const tabs = Array.from(container.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim().toLowerCase())
    expect(tabs).toContain("rare")
    expect(tabs).not.toContain("ultimate")
  })

  it("drops a blank tier rather than rendering an empty tab", async () => {
    const { container, findByText } = mount([
      deal({ distId: "a", tier: "", title: "Untiered" }),
      deal({ distId: "b", tier: "rare", title: "Rare One" }),
    ])
    await findByText("Untiered")
    const tabs = Array.from(container.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim())
    expect(tabs.filter((t) => t === "").length).toBe(0)
  })
})

describe("pack art", () => {
  it("bumps the CDN width param on hover preview and leaves other urls alone", async () => {
    const { container, findByText } = mount([
      deal({ imageUrl: "https://cdn.dapper/art.png?width=90&x=1", title: "Art Pack" }),
    ])
    await findByText("Art Pack")
    const holder = container.querySelector(".rpc-ps-pack-img")?.closest("span")
    expect(holder).toBeTruthy()
    fireEvent.mouseEnter(holder as Element)
    await waitFor(() => {
      const img = container.querySelector(".rpc-ps-preview-img") as HTMLImageElement | null
      expect(img).toBeTruthy()
      // width= bumped to 400; the unrelated query param survives untouched.
      expect(img!.src).toContain("width=400")
      expect(img!.src).toContain("x=1")
    })
  })

  it("renders a placeholder rather than a broken <img> when there is no art", async () => {
    const { container, findByText } = mount([deal({ imageUrl: "", title: "No Art Pack" })])
    await findByText("No Art Pack")
    expect(container.querySelector('img[src=""]')).toBeNull()
    expect(container.querySelector(".rpc-ps-pack-img-empty")).toBeTruthy()
  })
})
