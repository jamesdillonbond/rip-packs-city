// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import ProfileClient from "@/app/profile/[username]/ProfileClient"

// The 30-day portfolio-change readout on the PUBLIC collector profile, plus the
// rest of what the sibling suite left dark (55 uncovered branches — the largest
// gap in the component gate on a user-facing page).
//
// ⚠ FOUND BY WRITING THIS: `sparkChange` guarded its divide-by-zero with
//
//     ((last - first) / (first || 1)) * 100
//
// so a ZERO baseline silently became a $1 baseline. A collector whose first
// snapshot was $0 — a newly saved wallet, or one snapshotted before the FMV
// populate ran — had a rise to $500 rendered as "↑ 50000.0% / 30D" on a page
// they SHARE. A percentage change from zero is undefined, not enormous, and
// `|| 1` is the shape that turns "undefined" into a confident number.
//
// The fix omits the percentage and keeps the sparkline, because the SHAPE is
// real even when the ratio is not — which is also why the colour must not fall
// back to "down" just because the baseline was zero.

vi.mock("next/navigation", () => ({
  useParams: () => ({ username: "trevor" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

function installFetch(routes: Record<string, unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => routes[key] } as Response
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const wallet = (o: Record<string, unknown> = {}) => ({
  username: "trevor",
  display_name: "Main",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  cached_fmv: 12500,
  cached_moment_count: 250,
  cached_top_tier: "LEGENDARY",
  cached_rpc_score: 850,
  cached_badges: [],
  accent_color: "#E03A2F",
  ...o,
})

const PROFILE = {
  bio: { username: "trevor", display_name: "Trevor", accent_color: "#E03A2F", avatar_url: null },
  wallets: [wallet()],
}

/** Mount with a given snapshot series. */
async function mountWith(totals: number[]) {
  installFetch({
    "/api/public/profile/": PROFILE,
    "/api/profile/trophy-slabs": { slabs: [] },
    "/api/profile/portfolio-history": { snapshots: totals.map((t) => ({ total_fmv: t })) },
    "/api/profile/teams": { teams: [] },
    "/api/profile/me": { user: null },
  })
  const r = render(<ProfileClient />)
  await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
  return r
}

beforeEach(() => window.history.replaceState({}, "", "/profile/trevor"))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("30-day change is omitted when it cannot be computed", () => {
  it("does NOT invent a percentage from a ZERO baseline", async () => {
    // The regression case. 0 -> 500 under `|| 1` reads "↑ 50000.0% / 30D".
    const { container } = await mountWith([0, 500])
    const t = container.textContent ?? ""
    expect(t).not.toMatch(/50000/)
    expect(t, "no percentage at all is the honest output here").not.toMatch(/% \/ 30D/)
    // The sparkline still renders — the shape is real even when the ratio isn't.
    expect(container.querySelector("polyline")).toBeTruthy()
  })

  it("still colours a zero-baseline RISE as a rise, not a fall", async () => {
    // Direction is knowable even when the percentage is not. Falling back to
    // `sparkChange >= 0` on a null would paint a genuine gain red.
    const { container } = await mountWith([0, 500])
    expect(container.querySelector("polyline")?.getAttribute("stroke")).toBe("#34D399")
  })

  it("colours a decline red", async () => {
    const { container } = await mountWith([500, 100])
    expect(container.querySelector("polyline")?.getAttribute("stroke")).toBe("#F87171")
  })

  it("computes a real percentage when the baseline is positive", async () => {
    // The mirror: without it, suppressing the percentage everywhere would pass
    // every assertion above while deleting the feature.
    const { container } = await mountWith([100, 150])
    expect(container.textContent).toMatch(/↑\s*50\.0% \/ 30D/)
  })

  it("reports a decline with a down arrow and an absolute magnitude", async () => {
    // The arrow carries the sign, so the number itself is |change| — a "-50.0%"
    // beside a ↓ would read as a double negative.
    const { container } = await mountWith([200, 100])
    const t = container.textContent ?? ""
    expect(t).toMatch(/↓\s*50\.0% \/ 30D/)
    expect(t).not.toMatch(/-50\.0%/)
  })

  it("renders no change readout for a single snapshot", async () => {
    const { container } = await mountWith([500])
    expect(container.textContent).not.toMatch(/% \/ 30D/)
    expect(container.querySelector("polyline")).toBeNull()
  })

  it("reports 0.0% for a genuinely flat portfolio", async () => {
    // Distinct from the zero-baseline case: here the change really IS zero, and
    // saying so is correct. Collapsing the two would hide real information.
    const { container } = await mountWith([300, 300])
    expect(container.textContent).toMatch(/↑\s*0\.0% \/ 30D/)
  })
})

describe("the wallet list orders by collection then value", () => {
  it("groups by collection label and sorts FMV descending inside each", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PROFILE,
        wallets: [
          wallet({ display_name: "TS Small", cached_fmv: 10 }),
          wallet({ display_name: "AD One", collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", cached_fmv: 5 }),
          wallet({ display_name: "TS Big", cached_fmv: 9000 }),
        ],
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: null },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("TS Big")).toBeTruthy())
    const t = container.textContent ?? ""
    // The sort key is the registry LABEL, not the slug: "NBA Top Shot" <
    // "NFL All Day", so Top Shot's group comes first. Within it, 9000 > 10.
    expect(t.indexOf("TS Big")).toBeLessThan(t.indexOf("TS Small"))
    expect(t.indexOf("TS Small")).toBeLessThan(t.indexOf("AD One"))
  })

  it("labels an unknown collection id 'Multi' rather than leaking the uuid", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PROFILE,
        wallets: [wallet({ display_name: "Mystery", collection_id: "00000000-0000-0000-0000-000000000000" })],
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: null },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Mystery")).toBeTruthy())
    expect(container.textContent).toContain("Multi")
    expect(container.textContent).not.toContain("00000000-0000")
  })

  // 2026-09-02 (QA #6): one address is one row PER COLLECTION, so "Wallet N"
  // labelled a single wallet "Wallet 1 … Wallet 5". The collection is the label.
  it("falls back to the collection label when a wallet has no name", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PROFILE,
        wallets: [wallet({ display_name: null, username: null })],
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: null },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(container.textContent).toContain("Saved wallet"))
    expect(container.textContent).not.toContain("Wallet 1")
  })
})

describe("the RPC score band", () => {
  const scoreColorOf = (c: HTMLElement) =>
    (Array.from(c.querySelectorAll<HTMLElement>("div")).find((d) => /^\d+$/.test(d.textContent ?? ""))
      ?.style.color) ?? ""

  it("paints >=800 as success, >=500 as warning, below as danger", async () => {
    for (const [score, expected] of [
      [850, "var(--rpc-success)"],
      [800, "var(--rpc-success)"], // boundary: inclusive
      [650, "var(--rpc-warning)"],
      [500, "var(--rpc-warning)"], // boundary: inclusive
      [200, "var(--rpc-danger)"],
    ] as const) {
      installFetch({
        "/api/public/profile/": { ...PROFILE, wallets: [wallet({ cached_rpc_score: score })] },
        "/api/profile/trophy-slabs": { slabs: [] },
        "/api/profile/portfolio-history": { snapshots: [] },
        "/api/profile/teams": { teams: [] },
        "/api/profile/me": { user: null },
      })
      const { container, unmount } = render(<ProfileClient />)
      await waitFor(() => expect(screen.getByText(String(score))).toBeTruthy())
      expect(scoreColorOf(container), `score ${score}`).toBe(expected)
      unmount()
    }
  })

  it("hides the score entirely when no wallet carries one", async () => {
    installFetch({
      "/api/public/profile/": { ...PROFILE, wallets: [wallet({ cached_rpc_score: null })] },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: null },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    // Absent, not rendered as 0 — a zero would read as a real, terrible score.
    expect(container.textContent).not.toContain("RPC SCORE")
  })
})

describe("own-profile gating", () => {
  // ⚠ THIS BLOCK USED TO ASSERT THE OWNER *SEES* THE COST-BASIS CARD, and that
  // was a correct test for the behaviour that existed: the card was gated to
  // the owner, and the case pinned the case-insensitive username match so a
  // casing difference could not expose someone's spend.
  //
  // The card was removed from this page entirely on 2026-08-16 (Trevor). The
  // gating was never the risk — this is the page a collector POSTS, and a card
  // that renders for the owner is one screenshot from being public. So the
  // owner case is inverted below rather than deleted: kept as a positive
  // assertion that NOBODY sees it, including the viewer who used to.
  //
  // Cost basis is not gone from the product — it lives per-wallet on
  // /[collection]/analytics, covered by component-CostBasisCard-analytics.
  it("shows the cost-basis card to NOBODY, including the profile owner", async () => {
    installFetch({
      "/api/public/profile/": PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: { username: "TREVOR", id: "u1" } },
      "/api/profile/cost-basis-summary": { totalSpent: 4200, totalPurchases: 12, netPL: 900 },
      "/api/profile/collection-breakdown": { collections: [] },
      "/api/profile/top-movers": { gainers: [], losers: [] },
    })
    const { container } = render(<ProfileClient />)
    // Waits on the own-profile share block, which only renders once
    // /api/profile/me has resolved and matched — so this asserts the absence
    // AFTER the point where the card used to appear, not before it.
    await waitFor(() => expect(container.textContent).toMatch(/SHARE YOUR COLLECTION/i))
    expect(container.textContent).not.toMatch(/Cost Basis/i)
    expect(container.textContent).not.toMatch(/Total Spent/i)
    // The fixture above returns a real spend, so a card rendered from it would
    // show these figures. Nothing does.
    expect(container.textContent).not.toContain("4200")
    expect(container.textContent).not.toContain("$4.2K")
  })

  it("hides it from every other viewer", async () => {
    installFetch({
      "/api/public/profile/": PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: { username: "someone-else", id: "u2" } },
      "/api/profile/collection-breakdown": { collections: [] },
      "/api/profile/top-movers": { gainers: [], losers: [] },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    expect(container.textContent).not.toMatch(/Cost Basis/i)
  })

  it("hides it from an anonymous viewer", async () => {
    installFetch({
      "/api/public/profile/": PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/teams": { teams: [] },
      "/api/profile/me": { user: null },
      "/api/profile/collection-breakdown": { collections: [] },
      "/api/profile/top-movers": { gainers: [], losers: [] },
    })
    const { container } = render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    expect(container.textContent).not.toMatch(/Cost Basis/i)
  })
})
