// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

// app/profile/[username]/ProfileClient.tsx — the PUBLIC collector profile.
//
// ⚠ 627 lines, zero tests, and measured by NEITHER coverage gate: the primary
// gate takes route handlers + lib, and the component gate's app/ glob is
// `app/insights/**/*Client.tsx`, which does not reach app/profile. So the whole
// public profile surface — money formatting, the RPC-score colour bands, the
// portfolio sparkline, the trophy grid and the own-profile share block — had no
// coverage and contributed nothing to either ratchet.
//
// The formatters are the part worth pinning. `fmtDollars` deliberately
// thresholds on MAGNITUDE and re-attaches the sign, so a negative renders
// "-$1.5K" rather than "$-1500.00"; getting that wrong prints a plausible but
// wrong number on a public page. `hexToRgba` must fall back on a malformed
// accent colour rather than emit `rgba(NaN,NaN,NaN,…)`, which browsers drop —
// silently losing the user's chosen accent. Neither is exported, so both are
// asserted through the rendered DOM.

import ProfileClient from "@/app/profile/[username]/ProfileClient"
import { DEFAULT_AVATAR_URL } from "@/lib/profile/default-avatar"

vi.mock("next/navigation", () => ({
  useParams: () => ({ username: "trevor" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

/** Route → JSON, so each of the four mount fetches can be driven independently. */
function installFetch(routes: Record<string, unknown>, opts: { failing?: string[] } = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : (input as Request).url
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (opts.failing?.some((f) => url.includes(f))) {
      return { ok: false, status: 500, json: async () => ({}) } as Response
    }
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => routes[key] } as Response
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

const PUBLIC_PROFILE = {
  bio: {
    username: "trevor",
    display_name: "Trevor",
    tagline: "Blazers Team Captain",
    accent_color: "#E03A2F",
    avatar_url: null,
  },
  // Real SavedWalletPublic shape — the row label is display_name || username ||
  // "Wallet N", and there is no wallet_addr on this (privacy-stripped) view.
  wallets: [
    {
      username: "trevor",
      display_name: "Main",
      collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
      cached_fmv: 12500,
      cached_moment_count: 250,
      cached_top_tier: "LEGENDARY",
      cached_rpc_score: 850,
      cached_badges: [],
      accent_color: "#E03A2F",
    },
    {
      username: "trevor-alt",
      display_name: "Alt",
      collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070",
      cached_fmv: 42.5,
      cached_moment_count: 12,
      cached_top_tier: "RARE",
      cached_rpc_score: 400,
      cached_badges: [],
      accent_color: "#E03A2F",
    },
  ],
  favorite_teams: [{ team_name: "Portland Trail Blazers", league: "NBA" }],
}

beforeEach(() => {
  window.history.replaceState({}, "", "/profile/trevor")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ProfileClient — money formatting on a public page", () => {
  it("renders >=$1000 as a signed K-abbreviation and small values with cents", async () => {
    installFetch({
      "/api/public/profile/": PUBLIC_PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    const text = document.body.textContent ?? ""
    // 12500 -> $12.5K (one decimal), 42.5 -> $42.50 (cents)
    expect(text).toContain("$12.5K")
    expect(text).toContain("$42.50")
    // Never the unabbreviated raw value alongside it.
    expect(text).not.toContain("$12500.00")
  })

  it("keeps the sign OUTSIDE the dollar sign for a negative total", async () => {
    // The documented reason the helper thresholds on magnitude: a naive
    // implementation prints "$-1500.00", which reads as a price, not a loss.
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        wallets: [
          {
            username: "under",
            display_name: "Underwater",
            collection_id: null,
            cached_fmv: -1500,
            cached_moment_count: 3,
            cached_top_tier: null,
            cached_rpc_score: null,
            cached_badges: [],
            accent_color: "#E03A2F",
          },
        ],
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Underwater")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("-$1.5K")
    expect(text).not.toContain("$-1500")
  })

  it("renders an em-dash rather than $0.00 when there is no FMV", async () => {
    // A fabricated $0.00 reads as a real valuation of an empty portfolio.
    installFetch({
      "/api/public/profile/": { ...PUBLIC_PROFILE, wallets: [] },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    // "trevor" appears in several nodes (heading, wallet CTA), so wait on the
    // unique tagline instead of an ambiguous name match.
    await waitFor(() => expect(screen.getByText("Blazers Team Captain")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("—")
    expect(text).not.toContain("$0.00")
  })
})

describe("ProfileClient — resilience of the four independent mount fetches", () => {
  it("still renders the profile when the trophy + history reads fail", async () => {
    // The four reads are independent promises; one failing must not blank the
    // page, or a single slow/500 endpoint takes down a public profile.
    installFetch(
      {
        "/api/public/profile/": PUBLIC_PROFILE,
        "/api/profile/trophy-slabs": { slabs: [] },
        "/api/profile/portfolio-history": { snapshots: [] },
        "/api/profile/me": { user: null },
      },
      { failing: ["/api/profile/trophy-slabs", "/api/profile/portfolio-history"] }
    )
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    expect(document.body.textContent).toContain("Trevor")
  })

  it("renders from server-seeded props before any fetch resolves (SSR path)", async () => {
    // initialBio/initialWallets exist so the hero SSRs; if they were ignored the
    // page would flash empty on every load.
    installFetch({})
    render(
      <ProfileClient
        initialBio={PUBLIC_PROFILE.bio as never}
        initialWallets={PUBLIC_PROFILE.wallets as never}
      />
    )
    expect(document.body.textContent).toContain("Trevor")
    expect(document.body.textContent).toContain("Main")
  })

  it("survives a completely failed public profile read", async () => {
    installFetch({}, { failing: ["/api/"] })
    render(<ProfileClient />)
    // No crash, no unhandled rejection — a dead API must degrade, not throw.
    await waitFor(() => expect(document.body.textContent ?? "").not.toBe(""))
  })
})

describe("ProfileClient — the portfolio sparkline", () => {
  it("draws a polyline with one point per snapshot", async () => {
    installFetch({
      "/api/public/profile/": PUBLIC_PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": {
        snapshots: [
          { snapshot_date: "2026-08-01", total_fmv: 100 },
          { snapshot_date: "2026-08-02", total_fmv: 120 },
          { snapshot_date: "2026-08-03", total_fmv: 90 },
          { snapshot_date: "2026-08-04", total_fmv: 150 },
        ],
      },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(document.querySelector("polyline")).toBeTruthy())
    const pts = document.querySelector("polyline")?.getAttribute("points") ?? ""
    expect(pts.trim().split(/\s+/)).toHaveLength(4)
    // Geometry must be finite — a NaN in `points` makes the browser drop the
    // whole polyline, so the chart silently disappears rather than erroring.
    expect(pts).not.toMatch(/NaN|Infinity/)
  })

  it("draws NOTHING for a single snapshot rather than a degenerate line", async () => {
    installFetch({
      "/api/public/profile/": PUBLIC_PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [{ snapshot_date: "2026-08-01", total_fmv: 100 }] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    // One point is not a trend; drawing it would imply a flat history.
    expect(document.querySelector("polyline")).toBeNull()
  })

  it("does not divide by zero when every snapshot is identical", async () => {
    // range = max - min = 0; the helper guards with `|| 1`. Without it every y
    // is NaN and the sparkline vanishes.
    installFetch({
      "/api/public/profile/": PUBLIC_PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": {
        snapshots: [
          { snapshot_date: "2026-08-01", total_fmv: 100 },
          { snapshot_date: "2026-08-02", total_fmv: 100 },
          { snapshot_date: "2026-08-03", total_fmv: 100 },
        ],
      },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(document.querySelector("polyline")).toBeTruthy())
    expect(document.querySelector("polyline")?.getAttribute("points") ?? "").not.toMatch(/NaN/)
  })
})

describe("ProfileClient — accent colour handling", () => {
  it("does not emit rgba(NaN,…) for a malformed accent colour", async () => {
    // hexToRgba falls back when the hex is not 6 chars. Without the guard the
    // style is invalid, the browser drops it, and the user's accent silently
    // disappears — with nothing in any log.
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        bio: { ...PUBLIC_PROFILE.bio, accent_color: "#ZZ" },
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    expect(document.body.innerHTML).not.toMatch(/rgba\(NaN/)
  })

  it("applies a valid accent colour", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        bio: { ...PUBLIC_PROFILE.bio, accent_color: "#00FF00" },
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    expect(document.body.innerHTML).toMatch(/rgba\(0,\s*255,\s*0/)
  })
})

describe("ProfileClient — the avatar a collector gets before they set one", () => {
  // The RPC logo is the default (lib/profile/default-avatar.ts). Asserted
  // through the rendered DOM because the Avatar component is not exported, and
  // because the thing that matters is what a visitor SEES — the module's own
  // unit test can only prove the string is right, not that this page uses it.
  const routes = {
    "/api/profile/trophy-slabs": { slabs: [] },
    "/api/profile/portfolio-history": { snapshots: [] },
    "/api/profile/me": { user: null },
  }

  it("renders the RPC logo when avatar_url is null", async () => {
    installFetch({ "/api/public/profile/": PUBLIC_PROFILE, ...routes })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    const img = document.querySelector('img[alt="trevor"]') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute("src")).toBe(DEFAULT_AVATAR_URL)
    // The monogram is now reachable ONLY via onError (which swaps it in by
    // mutating the parent), so the avatar slot must contain the image and no
    // text. Asserted on the PARENT rather than on document.body, because "TR"
    // is a substring of half the copy on this page — the first version of this
    // assertion failed for exactly that reason and proved nothing about the
    // avatar either way.
    expect(img.parentElement?.textContent).toBe("")
  })

  it("still prefers the collector's own avatar over the default", async () => {
    // The mirror-image assertion. A default that quietly overrides a chosen
    // avatar is a worse bug than no default at all, and it is exactly what a
    // careless `resolveAvatarUrl(DEFAULT)` argument order would produce.
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        bio: { ...PUBLIC_PROFILE.bio, avatar_url: "https://example.com/me.png" },
      },
      ...routes,
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    const img = document.querySelector('img[alt="trevor"]') as HTMLImageElement
    expect(img.getAttribute("src")).toBe("https://example.com/me.png")
  })
})

// 2026-09-02 (onboarding QA #6): the headline must be the DASHBOARD's number —
// total minus the stale-priced portion — with the stale portion as a caption.
// The page used to sum the flat total, so a collector posted "$88.4K" while
// their dashboard read "$48,872 + $39,553 across 370 stale-priced".
describe("ProfileClient — portfolio FMV uses the dashboard's stale split", () => {
  it("holds stale-priced value out of the headline and shows it as a caption", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        wallets: [
          { ...PUBLIC_PROFILE.wallets[0], cached_fmv: 88425, cached_fmv_stale: 39553, cached_stale_count: 370, cached_moment_count: 19381 },
        ],
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("$48.9K") // 88425 - 39553 = 48872
    expect(text).not.toContain("$88.4K")
    expect(text).toMatch(/\+ \$39\.6K across 370 stale-priced/)
  })

  it("a payload without the split (not yet reconciled) still renders the total, no caption", async () => {
    installFetch({
      "/api/public/profile/": PUBLIC_PROFILE,
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("Main")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toContain("$12.5K")
    expect(text).not.toMatch(/stale-priced/)
  })

  it("labels a wallet row by its collection, not 'Wallet N', when it has no name", async () => {
    installFetch({
      "/api/public/profile/": {
        ...PUBLIC_PROFILE,
        wallets: PUBLIC_PROFILE.wallets.map((w) => ({ ...w, username: null, display_name: null })),
      },
      "/api/profile/trophy-slabs": { slabs: [] },
      "/api/profile/portfolio-history": { snapshots: [] },
      "/api/profile/me": { user: null },
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText("SAVED WALLETS")).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/Wallet [0-9]/)
  })
})
