// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

// The public profile must not make promises the product cannot keep, and must
// not put a collector's SPEND on the page they share.
//
// Removed 2026-08-16 (Trevor):
//   • the "+50 Status / more Status" share copy and the Achievements section —
//     the rewards program is not built out, so nothing user-facing may offer
//     points. Sharing itself is real and stays.
//   • the Cost Basis · P/L card. It was already own-view-only, but the gating
//     was never the risk: this is the page a collector POSTS, and a card that
//     renders for the owner is one screenshot from being public. Cost basis
//     still lives per-wallet on /[collection]/analytics.
//
// Asserted through the rendered DOM rather than by grepping the source, because
// what matters is what a visitor SEES — a source guard would pass on a section
// that was merely moved behind a flag that defaults on.

import ProfileClient from "@/app/profile/[username]/ProfileClient"

vi.mock("next/navigation", () => ({
  useParams: () => ({ username: "trevor" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const PROFILE = {
  bio: { username: "trevor", display_name: "Trevor", accent_color: "#E03A2F", avatar_url: null },
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
  ],
  wallet_count: 1,
}

// Own-profile view: /api/profile/me returning THIS username is what unlocks the
// share block and (previously) the cost-basis card, so it is the strictest case
// — anything still rendering rewards or P&L will render here.
function installFetch(profile: unknown = PROFILE) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url
      const body: Record<string, unknown> = url.includes("/api/public/profile/")
        ? (profile as Record<string, unknown>)
        : url.includes("/api/profile/me")
          ? { user: { username: "trevor", id: "u1" } }
          : url.includes("trophy-slabs")
            ? { slabs: [] }
            : url.includes("portfolio-history")
              ? { snapshots: [] }
              : // ⚠ THIS PAYLOAD IS LOAD-BEARING AND THE TEST WAS VACUOUS WITHOUT
                // IT. PublicAchievements returns null on an empty list, so with a
                // `{}` stub the "no achievements section" assertion passed
                // whether the component was mounted or not — remounting it
                // survived a mutation run. A real unlocked achievement is what
                // makes the section render, and therefore what makes its ABSENCE
                // mean anything. `pack_hunter` is a real key in ACHIEVEMENT_DEFS.
                url.includes("/api/profile/achievements")
                ? { achievements: [{ achievement_key: "pack_hunter", tier: "platinum" }] }
                : {}
      return { ok: true, status: 200, json: async () => body } as Response
    }),
  )
}

beforeEach(() => installFetch())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("public profile makes no rewards promise", () => {
  it("shows the share block but never offers points for it", async () => {
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/SHARE YOUR COLLECTION/i)).toBeTruthy())
    const text = document.body.textContent ?? ""
    // Sharing is real — it stays. The copy follows the case: "trophy case"
    // when something is pinned, "portfolio … pin a trophy first" when not
    // (re-QA 2026-09-03), so either reading proves the block is there.
    expect(text).toMatch(/Post your (trophy case|portfolio) on X or Discord/i)
    // The promise is not.
    expect(text).not.toMatch(/\+50/)
    expect(text).not.toMatch(/Status/i)
    expect(text).not.toMatch(/when a friend joins/i)
  })

  it("with nothing pinned, invites posting the PORTFOLIO and pinning first — not sharing an empty case (re-QA 2026-09-03)", async () => {
    // The fixture's trophy-slabs is `{ slabs: [] }`.
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/SHARE YOUR COLLECTION/i)).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).toMatch(/Post your portfolio on X or Discord/i)
    expect(text).toMatch(/pin a trophy first/i)
    expect(text).not.toMatch(/Post your trophy case/i)
  })

  it("renders no achievements section", async () => {
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/SHARE YOUR COLLECTION/i)).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/ACHIEVEMENTS/i)
    expect(text).not.toMatch(/UNLOCKED/i)
  })
})

describe("public profile shows FMV but not spend", () => {
  it("keeps portfolio FMV", async () => {
    // The mirror assertion: stripping P&L must not strip the holdings value,
    // which is what the page is FOR.
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/PORTFOLIO FMV/i)).toBeTruthy())
    expect(document.body.textContent).toContain("$12.5K")
  })

  it("renders no cost-basis or P/L card, even on your own profile", async () => {
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/PORTFOLIO FMV/i)).toBeTruthy())
    const text = document.body.textContent ?? ""
    expect(text).not.toMatch(/Cost Basis/i)
    expect(text).not.toMatch(/P\/L/i)
    expect(text).not.toMatch(/Total Spent/i)
  })

  it("never requests the cost-basis endpoint at all", async () => {
    // Stronger than the copy assertion: proves the card is GONE rather than
    // rendered-empty, and that we are not shipping a collector's spend to the
    // browser on a page they share.
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/PORTFOLIO FMV/i)).toBeTruthy())
    const urls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (c) => String(c[0]),
    )
    expect(urls.some((u) => u.includes("cost-basis"))).toBe(false)
  })
})

describe("the WALLETS tile counts addresses, not saved_wallets rows", () => {
  it("renders the server's wallet_count, not wallets.length", async () => {
    // Four rows, one address — the live shape for a single Dapper wallet that
    // holds moments in four collections.
    installFetch({
      ...PROFILE,
      wallets: [1, 2, 3, 4].map((i) => ({ ...PROFILE.wallets[0], collection_id: "c" + i })),
      wallet_count: 1,
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/PORTFOLIO FMV/i)).toBeTruthy())
    await waitFor(() => expect(document.body.textContent).toMatch(/1 WALLET\b/))
    expect(document.body.textContent).not.toMatch(/4 WALLETS/)
  })

  it("pluralises a genuine multi-wallet collector", async () => {
    installFetch({ ...PROFILE, wallet_count: 3 })
    render(<ProfileClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/3 WALLETS/))
  })

  it("omits the line entirely rather than guessing when the count is absent", async () => {
    // Falling back to wallets.length is exactly the bug; showing nothing is the
    // honest answer when the server did not tell us.
    const { wallet_count: _drop, ...noCount } = PROFILE
    installFetch(noCount)
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/PORTFOLIO FMV/i)).toBeTruthy())
    // Matches a COUNT line specifically. A bare /WALLET/ also hits the "SAVED
    // WALLETS" section heading further down the page, so it would fail against
    // correct code — which is what it did on the first run here.
    expect(document.body.textContent).not.toMatch(/\d+\s+WALLETS?\b/)
  })
})

// 2026-09-03: the header's ANALYZE link searched Top Shot for the RPC HANDLE
// (`?q=<handle>`), a different namespace — it worked only when the handle
// happened to equal the Top Shot username. It must carry a saved wallet's Top
// Shot username, and it must not render at all when none is known.
describe("public profile — the ANALYZE link carries a Top Shot username, never the handle", () => {
  it("links ?q= to the saved wallet's Top Shot username", async () => {
    installFetch({ ...PROFILE, bio: { ...PROFILE.bio, username: "qa0903b" }, wallets: [{ ...PROFILE.wallets[0], username: "jamesdillonbond" }] })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/ANALYZE/i)).toBeTruthy())
    const a = screen.getByText(/ANALYZE/i).closest("a")!
    expect(a.getAttribute("href")).toBe("/nba-top-shot/collection?q=jamesdillonbond")
    expect(a.getAttribute("href")).not.toContain("qa0903b")
  })

  it("renders no ANALYZE link when no wallet has a known Top Shot username", async () => {
    installFetch({ ...PROFILE, wallets: [{ ...PROFILE.wallets[0], username: null }] })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/SHARE YOUR COLLECTION/i)).toBeTruthy())
    expect(screen.queryByText(/ANALYZE/i)).toBeNull()
  })
})

// 2026-09-06: the SAVED WALLETS rows. The UFC Strike row printed "$0.00" under a
// breakdown that said "market closed" for the same wallet, and every row's
// LOAD → went to /nba-top-shot regardless of the row's own collection.
describe("public profile — saved-wallet rows are honest about closed markets and load their OWN collection", () => {
  it("a closed-market row says 'market closed' instead of a dollar figure, and LOAD → targets the row's collection", async () => {
    installFetch({
      ...PROFILE,
      wallets: [
        { ...PROFILE.wallets[0], username: "jamesdillonbond", collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", cached_fmv: 0, cached_moment_count: 247 },
        { ...PROFILE.wallets[0], username: "jamesdillonbond", collection_id: "7dd9dd11-e8b6-45c4-ac99-71331f959714", cached_fmv: 878.69, cached_moment_count: 186 },
      ],
    })
    render(<ProfileClient />)
    await waitFor(() => expect(screen.getByText(/SAVED WALLETS/i)).toBeTruthy())
    expect(document.body.textContent).toMatch(/market closed/i)
    expect(document.body.textContent).not.toMatch(/\$0\.00/)
    const loads = screen.getAllByText(/LOAD/).map((el) => el.closest("a")!.getAttribute("href"))
    expect(loads).toContain("/ufc/collection?wallet=jamesdillonbond")
    expect(loads).toContain("/disney-pinnacle/collection?wallet=jamesdillonbond")
    expect(loads.some((h) => h?.startsWith("/nba-top-shot/collection?wallet="))).toBe(false)
  })
})
