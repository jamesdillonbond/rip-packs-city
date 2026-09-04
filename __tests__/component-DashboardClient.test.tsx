// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import DashboardClient from "@/app/dashboard/DashboardClient"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// `/dashboard` converted to a `*Client.tsx` so the component gate measures it — 2,545 lines,
// the largest client page in the repo, and the one carrying the most accumulated honesty
// logic: `meFailed`, `statsFailed`, the hero-picker's `loadFailed`, the trophy reorder's
// optimistic rollback, and the "empty slabs means two different things" gate.
//
// ⚠ NO NEW DEFECT, and that is the finding: every branch below already had a comment naming
// the incident that produced it. What none of them had was a test. A source grep proves a
// string is present; it cannot prove the branch is REACHABLE, that it precedes the empty
// state, or that a later edit has not made it unreachable. These drive each one.
//
// The four properties worth stating plainly:
//   * /dashboard is auth-gated, so a reader who sees it IS signed in — `email === null` means
//     either an expired session or a failed `/api/profile/me`, and rendering "Not signed in"
//     for the second is a false claim on the one page that disproves it.
//   * A failed per-wallet stats read must not sum to a confident "$0 / 0 moments" (the
//     2026-08-05 incident: a statement timeout produced a false $0 on a 19,213-moment wallet).
//   * Empty slabs mean "pinned nothing" OR "the read failed"; on the second, replacing a full
//     trophy case with the onboarding prompt reads as "your trophy case is gone".
//   * A failed trophy removal must roll the row BACK, or the slot stays visually empty while
//     the DB still holds it.

let searchParams = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => searchParams,
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => {
    // Keep data-* attributes (the tour anchors on them); drop Next-only props.
    const data: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rest)) if (k.startsWith("data-")) data[k] = v
    return (
      <a href={typeof href === "string" ? href : "#"} {...data}>
        {children}
      </a>
    )
  },
}))
vi.mock("@/components/MobileNav", () => ({ default: () => null }))
vi.mock("@/components/SupportChatConnected", () => ({ default: () => null }))
vi.mock("@/components/onboarding/FirstRunTourMount", () => ({ default: () => null }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <span>RPC</span> }))
vi.mock("@/components/auth/SignOutButton", () => ({ default: () => <button>Sign out</button> }))
// ⚠ Expose the callbacks. A marker-only modal mock leaves the page's own
// `onClose` / `onPinned` / `onSaved` handlers — which toast and refresh —
// unreachable, and a test that merely asserts the modal MOUNTED does not
// exercise a single line of the page's response to it.
vi.mock("@/components/profile/TrophyPickerModal", () => ({
  default: (p: Record<string, unknown>) => (
    <div data-testid="trophy-picker" data-replacing={String(p.replacingName ?? "")}>
      <button data-testid="picker-close" onClick={p.onClose as () => void} />
      <button data-testid="picker-pinned" onClick={p.onPinned as () => void} />
    </div>
  ),
}))
vi.mock("@/components/profile/TrophyNoteEditor", () => ({
  default: (p: Record<string, unknown>) => (
    <button
      data-testid={`note-editor-${String(p.slot ?? "")}`}
      onClick={() => (p.onSaved as (s: number, n: string | null) => void)(Number(p.slot), "chased upstream")}
    />
  ),
}))
vi.mock("@/components/profile/ShareProfileButtons", () => ({ default: () => <div data-testid="share-buttons" /> }))
// ⚠ The prop is `slab`, not `data`, and the component also receives the SLOT
// separately — the page passes the array position for the packed list and the
// grid cell's own slot elsewhere. Both are surfaced so a slot/position mix-up
// is observable rather than silently absorbed.
vi.mock("@/components/TrophySlab", () => ({
  default: (p: Record<string, unknown>) => {
    const d = p.slab as { slot?: number; player_name?: string } | null | undefined
    return (
      <div
        data-testid="trophy-slab"
        data-slot={String(d?.slot ?? "")}
        data-rendered-slot={String(p.slot ?? "")}
      >
        {d?.player_name ?? ""}
        {/* ⚠ The page passes `onRemove` to the SLAB, so a marker-only mock
            leaves `handleRemoveTrophy` unreachable — and an `if (btn)` guard
            around the click then passes while asserting nothing. Measured:
            the function was NOT covered until this button existed. */}
        {typeof p.onRemove === "function" && d ? (
          <button data-testid={`remove-slab-${d.slot}`} onClick={() => (p.onRemove as (s: number) => void)(d.slot!)}>
            remove
          </button>
        ) : null}
      </div>
    )
  },
}))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body } as unknown as Response
}

const ME = { user: { email: "collector@example.test", id: "u-1", display_name: "Collector" } }
const WALLET = (over: Record<string, unknown> = {}) => ({
  id: "w-1",
  wallet_addr: "0xmine",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  username: "collector",
  verified_at: new Date().toISOString(),
  verification_method: "listing_challenge",
  ...over,
})
const SLAB = (over: Record<string, unknown> = {}) => ({
  // `id` is load-bearing — the reorder buttons call `moveBy(s.id, …)`.
  id: 1,
  slot: 1,
  edition_id: "48:1652",
  thumbnail_url: null,
  video_url: null,
  fmv: 60,
  fmv_confidence: "HIGH",
  moment_id: "9001",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  player_name: "Damian Lillard",
  set_name: "Archive Set",
  tier: "RARE",
  serial_number: 12,
  circulation_count: 1000,
  image_url: null,
  fmv_usd: 60,
  note: null,
  ...over,
})

type Routes = Record<string, () => Response>
let routes: Routes
let fetchMock: ReturnType<typeof vi.fn>

function baseRoutes(): Routes {
  return {
    "/api/profile/me": () => json(200, ME),
    "/api/profile/bio": () => json(200, { bio: { display_name: "Collector", username: "collector" } }),
    "/api/profile/saved-wallets": () => json(200, { wallets: [WALLET()] }),
    "/api/profile/trophy-slabs": () => json(200, { slabs: [SLAB()] }),
    "/api/profile/favorites": () => json(200, { favorites: [] }),
    "/api/profile/activity": () => json(200, { activity: [] }),
    "/api/profile/hero-moment": () => json(200, { hero: null }),
    // ⚠ `/api/profile/collection-stats`, NOT `/api/collection-stats`. The first
    // draft of this file used the latter, so every stats fixture fell through to
    // the catch-all and the `statsFailed` honesty test passed for the wrong
    // reason — the branch it exists to pin was never reached.
    "/api/profile/collection-stats": () => json(200, { stats: [] }),
    "/api/profile/top-moments": () => json(200, { moments: [] }),
  }
}

beforeEach(() => {
  searchParams = new URLSearchParams()
  routes = baseRoutes()
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    const key = Object.keys(routes).filter((k) => url.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    return key ? routes[key]() : json(200, {})
  })
  vi.stubGlobal("fetch", fetchMock)
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * First visit: the wallets section no longer duplicates the hero's add-wallet
 * form (2026-09-02); its copy is behind an "add one here" link. Reveal it when
 * present so the section-form tests keep exercising the section's callbacks.
 */
async function revealSectionForm() {
  const link = await screen.findByRole("button", { name: /add one here/i }).catch(() => null)
  if (link) fireEvent.click(link)
}

// ─── The signed-in claim ─────────────────────────────────────────────────────

describe("DashboardClient — a failed /me must not say 'Not signed in'", () => {
  it("does not tell a signed-in collector they are signed out when /me fails", async () => {
    // ⚠ /dashboard is auth-gated by proxy.ts, so the reader IS signed in. The
    // render used to collapse "session genuinely absent" and "/api/profile/me
    // failed" into one null, and stated the first — on the one page that
    // disproves it.
    routes["/api/profile/me"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Not signed in/i)).toBeNull())
  })

  it("renders the collector's identity on a good read", async () => {
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/collector/i))
  })

  it("survives a /me body with no user at all", async () => {
    routes["/api/profile/me"] = () => json(200, { user: null })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})

// ─── The trophy case ─────────────────────────────────────────────────────────

describe("DashboardClient — the trophy case", () => {
  it("renders a pinned trophy", async () => {
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
    expect(document.body.textContent).toContain("Damian Lillard")
  })

  it("does not ask for a hero moment when trophies are pinned", async () => {
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/profile/hero-moment"))).toBe(false)
  })

  it("asks for a hero moment only when the case is genuinely empty", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await waitFor(() => {
      expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/profile/hero-moment"))).toBe(true)
    })
  })

  it("⚠ does NOT replace the case with the onboarding prompt when the slab read FAILED", async () => {
    // Empty slabs mean two things — "pinned nothing" and "the read failed" —
    // and the branch is gated on `slabsRes.ok` so an outage leaves the case as
    // it was rather than telling an owner their trophy case is gone.
    //
    // ⚠⚠ THIS TEST PASSED WHILE THE DEFECT WAS LIVE (found 2026-08-26). Its
    // title promises the onboarding prompt is not RENDERED; every assertion it
    // had only proved /api/profile/hero-moment was not FETCHED. Those are
    // different claims: gating the hero FETCH on `slabsRes.ok` stops `hero`
    // being set, but `filledSlabs.length === 0` then fell through to
    // <EmptyHeroState> anyway, so on first load a failed read still showed a
    // collector with six pinned trophies "Pin a moment to your trophy case".
    // The repo records this exact shape: a test stating its contract in a
    // comment and asserting something weaker, and the tell is the TITLE.
    // ⭐ Assert the ABSENCE OF THE FALSE CLAIM, not the absence of a fetch.
    routes["/api/profile/trophy-slabs"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("/api/profile/hero-moment"))).toBe(false)
    // The claim itself must not be on the page.
    expect(screen.queryByText(/Pin a moment to your trophy case/i)).toBeNull()
    expect(screen.queryByText(/build your six-slot showcase/i)).toBeNull()
    // And the reader must be told the difference between empty and unreadable.
    expect(screen.getByText(/loading problem, not an empty case/i)).toBeTruthy()
  })

  it("still shows the onboarding prompt when the slab read SUCCEEDS and the case is genuinely empty", async () => {
    // NO-CHANGE CONTROL for the test above. Without this, hiding the prompt
    // unconditionally would satisfy that assertion and silently break real
    // onboarding — the guard would punish its own success.
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/loading problem, not an empty case/i)).toBeNull()
  })

  it("survives a slabs body whose slabs key is not an array", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: "nope" })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("ignores a slab whose slot is out of range rather than writing past the array", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [SLAB({ slot: 99 }), SLAB({ slot: 0 })] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("places each slab at its persisted slot, not at its array position", async () => {
    // ⚠ Filled slabs pack to the FRONT while `slot` is the persisted column, so
    // indexing by array position captions the wrong Moment after a reorder.
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, { slabs: [SLAB({ id: 3, slot: 3, player_name: "Third" }), SLAB({ id: 1, slot: 1, player_name: "First" })] })
    render(<DashboardClient />)
    await waitFor(() => {
      const slabs = screen.getAllByTestId("trophy-slab")
      // The mock's own remove button contributes text, so match on containment.
      const bySlot = new Map(slabs.map((s) => [s.getAttribute("data-slot"), s.textContent ?? ""]))
      expect(bySlot.get("1")).toContain("First")
      expect(bySlot.get("3")).toContain("Third")
    })
  })
})

// ─── Per-wallet stats ────────────────────────────────────────────────────────

describe("DashboardClient — per-wallet collection stats", () => {
  it("requests stats for each unique wallet address", async () => {
    routes["/api/profile/saved-wallets"] = () =>
      json(200, { wallets: [WALLET(), WALLET({ id: "w-2", collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070" })] })
    render(<DashboardClient />)
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("collection-stats"))
      // ⚠ ONE call for the address, not one per (address, collection) row —
      // `saved_wallets` is keyed per collection, so a naive per-row fetch is N
      // duplicate queries for the same wallet.
      expect(calls.length).toBe(1)
    })
  })

  it("does not publish a confident $0 when a stats read fails", async () => {
    // ⚠ The 2026-08-05 incident: `get_wallet_collection_stats` crossed its
    // statement timeout, the 503 left `statsByWallet[addr]` unset, and the sum
    // helpers reduced it to a hard $0 on a 19,213-moment wallet — indistinguishable
    // from actually owning nothing.
    routes["/api/profile/collection-stats"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(document.body.textContent).not.toMatch(/\$0\.00/))
  })

  it("survives a thrown stats read", async () => {
    routes["/api/profile/collection-stats"] = () => { throw new Error("stats down") }
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("renders real per-collection figures when the read succeeds", async () => {
    routes["/api/profile/collection-stats"] = () =>
      json(200, {
        stats: [
          {
            collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
            moment_count: 42,
            fmv_total: 1234,
            locked_count: 2,
            fmv_max: 300,
            stale_fmv_total: 0,
            stale_count: 0,
          },
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("collection-stats"))).toBe(true))
  })
})

// ─── Wallets ─────────────────────────────────────────────────────────────────

describe("DashboardClient — wallets", () => {
  // ⚠ THIS CASE EXISTED AND WAS VACUOUS, AND THAT IS WHY THE DEFECT SHIPPED.
  // It was named exactly right — "without claiming none are saved" — and its
  // entire body was `await waitFor(() => expect(fetchMock).toHaveBeenCalled())`,
  // which passes whatever the page renders. Same family as the /insights/
  // pack-reality case: a test that STATES the contract and enforces something
  // weaker. Assert the ABSENCE of the false claim, not that a fetch happened.
  it("does not show the onboarding banner when the saved-wallets read FAILED", async () => {
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    // The honest notice appears...
    expect(await screen.findByText(/Couldn't load your saved wallets/i)).toBeTruthy()
    // ...and the onboarding prompt — a claim about the reader's OWN account,
    // actionable in the worst way (it asks them to re-add a wallet they have) —
    // must NOT.
    expect(screen.queryByText(/Welcome to Rip Packs City/i)).toBeNull()
  })

  it("still shows the onboarding banner when the read SUCCEEDS and there genuinely are none", async () => {
    // Both directions. A fix that blanks the banner on every empty list would
    // break real onboarding, which is the mirror-image defect.
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    expect(await screen.findByText(/Welcome to Rip Packs City/i)).toBeTruthy()
    expect(screen.queryByText(/Couldn't load your saved wallets/i)).toBeNull()
  })

  it("marks the headline totals unavailable when the saved-wallets read failed", async () => {
    // refreshStats([]) early-returns and CLEARS statsFailed, so before the fix
    // the tiles fell through to a confident "0 moments / $0" with no notice --
    // the same false-$0 the 2026-08-05 incident produced, reached one route
    // earlier. The copy must not say "holdings for 0 wallets".
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    render(<DashboardClient />)
    expect(await screen.findByText(/totals are unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/holdings for 0/i)).toBeNull()
  })

  it("re-reads the wallet list on Retry and RECOVERS, not just re-fetching stats", async () => {
    // A Retry that calls refreshStats([]) changes nothing, because the empty
    // list IS the failure. An action offered for a state it cannot fix is its
    // own dishonesty.
    //
    // ⚠ Asserted by RECOVERY rather than by a call count, for two reasons: it
    // proves the retry reaches the failing route (a count only proves something
    // was requested), and it lets the whole refresh chain settle INSIDE this
    // test. `cleanup()` unmounts but does not cancel in-flight promises, and
    // `beforeEach` installs a fresh fetchMock — so a still-pending refresh
    // resolves into the NEXT test's mock and inflates its call counts. That is
    // exactly what broke the sibling "groups the same address" case, which
    // asserts an upper bound on collection-stats calls.
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    render(<DashboardClient />)
    await screen.findByText(/Couldn't load your saved wallets/i)

    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET()] })
    fireEvent.click(screen.getAllByText(/Retry/i)[0])

    await waitFor(() => expect(screen.queryByText(/Couldn't load your saved wallets/i)).toBeNull())
  })

  it("the TOTALS panel's Retry also re-reads the list, not just the stats", async () => {
    // ⚠ Two Retry buttons render on this path and they call DIFFERENT things:
    // the hero notice calls refresh() directly, the totals notice calls
    // retryStats(). The first version of the test above clicked
    // getAllByText(/Retry/i)[0] — the hero one — so the retryStats branch was
    // MASKED: deleting it left every test green. Caught by mutation, not review.
    // This clicks the totals button specifically.
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    render(<DashboardClient />)
    await screen.findByText(/Totals are unavailable until your saved wallets load/i)

    const retries = screen.getAllByText(/Retry/i)
    expect(retries.length).toBeGreaterThan(1) // not vacuous: both notices are up
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET()] })
    fireEvent.click(retries[retries.length - 1])

    await waitFor(() =>
      expect(screen.queryByText(/Totals are unavailable until your saved wallets load/i)).toBeNull()
    )
  })

  it("groups the same address across collections into one card", async () => {
    // ⚠ `saved_wallets` is keyed per (wallet_addr, collection_id), so one
    // pinned Dapper address is several rows. Counting rows as wallets is the
    // fabricated-number shape this repo has already paid for on /profile.
    routes["/api/profile/saved-wallets"] = () =>
      json(200, {
        wallets: [
          WALLET(),
          WALLET({ id: "w-2", collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070" }),
          WALLET({ id: "w-3", collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75" }),
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const addrCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("collection-stats"))
    expect(addrCalls.length).toBeLessThanOrEqual(1)
  })

  it("renders the sign-in banner when the collector has saved no wallets", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("treats an unverified wallet differently from a verified one", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})

// ─── Favourites and activity ─────────────────────────────────────────────────

describe("DashboardClient — favourites and activity", () => {
  it("survives a failed favourites read", async () => {
    routes["/api/profile/favorites"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("survives a failed activity read", async () => {
    routes["/api/profile/activity"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("renders a friend-activity row when there is one", async () => {
    routes["/api/profile/activity"] = () =>
      json(200, {
        activity: [
          {
            id: "a-1",
            actor_username: "friend",
            kind: "trophy_pinned",
            created_at: new Date().toISOString(),
            summary: "pinned a trophy",
          },
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("renders a favourite team when there is one", async () => {
    routes["/api/profile/favorites"] = () =>
      json(200, { favorites: [{ id: "f-1", kind: "team", label: "Portland Trail Blazers", slug: "portland-trail-blazers" }] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})

// ─── Whole-dashboard failure ─────────────────────────────────────────────────

describe("DashboardClient — whole-dashboard failure", () => {
  it("retries once before giving up on a network rejection", async () => {
    // ⚠ An iOS "TypeError: Load failed" used to escape as an unhandled
    // rejection and leave a blank dashboard. It retries once, then degrades to
    // a toast rather than a broken page.
    vi.useFakeTimers()
    try {
      let calls = 0
      fetchMock.mockImplementation(async () => {
        calls += 1
        throw new Error("Load failed")
      })
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      const afterFirst = calls
      expect(afterFirst).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(calls).toBeGreaterThan(afterFirst)
    } finally {
      vi.useRealTimers()
    }
  })

  it("degrades to a toast rather than a blank dashboard after the retry", async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(async () => { throw new Error("Load failed") })
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(100)
      expect(document.body.textContent).toMatch(/couldn.t load your dashboard/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── URL-driven modals ───────────────────────────────────────────────────────

describe("DashboardClient — URL-driven modals", () => {
  it("opens the pin modal at the requested slot", async () => {
    searchParams = new URLSearchParams("pin=3")
    render(<DashboardClient />)
    expect(await screen.findByTestId("trophy-picker")).toBeTruthy()
  })

  it("falls back to slot 1 for an out-of-range pin param", async () => {
    searchParams = new URLSearchParams("pin=99")
    render(<DashboardClient />)
    expect(await screen.findByTestId("trophy-picker")).toBeTruthy()
  })

  it("falls back to slot 1 for a non-numeric pin param", async () => {
    searchParams = new URLSearchParams("pin=abc")
    render(<DashboardClient />)
    expect(await screen.findByTestId("trophy-picker")).toBeTruthy()
  })

  it("opens no modal without a pin param", async () => {
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId("trophy-picker")).toBeNull()
  })
})

// ─── Adding a wallet ─────────────────────────────────────────────────────────

describe("DashboardClient — adding a wallet", () => {
  /**
   * ⚠ TWO "Load my collection" buttons render — the sign-in banner has its own
   * copy of the add-wallet form alongside the wallets section's. They drive the
   * same `resolveAndAssociate` callback but read DIFFERENT input state, so
   * clicking the wrong one submits an empty field. Return the input AND the
   * button that belongs to it, found by walking up to their shared container.
   */
  
async function openAddForm(over: Record<string, unknown> = {}) {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    Object.assign(routes, over)
    render(<DashboardClient />)
    await revealSectionForm()
    const box = await screen.findByPlaceholderText("Dapper username")
    const row = box.closest("div")!
    const submit = Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Load my collection",
    )!
    return { box, submit }
  }

  it("refuses an empty identifier without calling the API", async () => {
    const { box, submit } = await openAddForm()
    fireEvent.change(box, { target: { value: "   " } })
    fireEvent.click(submit)
    // ⚠ `findAllByText` — both add-wallet forms share the same `usernameError`
    // state, so the message renders twice.
    await screen.findAllByText(/Wallet address or username required/)
    // ⚠ Scoped to the RESOLVE endpoint. A total call count keeps moving as the
    // page's background legs tick, so it flaked under full-suite load while
    // passing in isolation — the third time this session that a count-of-
    // everything assertion turned out to be a clock measurement.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("resolve-and-associate"))).toBe(false)
  })

  it("sends a 0x address as an ADDRESS, not as a username", async () => {
    // ⚠ The shape decides the path. A Flow address handed to the username
    // resolver resolves nothing; a username handed to the address path is
    // stored as a literal address that matches no cache row.
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () =>
        json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a", "b"] }),
    })
    fireEvent.change(box, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(submit)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("resolve-and-associate"))
      expect(call).toBeTruthy()
      expect(String((call![1] as RequestInit).body)).toContain('"address"')
    })
  })

  it("sends a non-address as a USERNAME", async () => {
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () =>
        json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a"] }),
    })
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.click(submit)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("resolve-and-associate"))
      expect(String((call![1] as RequestInit).body)).toContain('"username"')
    })
  })

  it("after a wallet is saved, the stat tiles say 'Indexing your wallet…' instead of publishing 0 / $0 while nothing has counted yet (2026-09-04)", async () => {
    // The saved-wallets list now carries the wallet, but collection-stats has no
    // counted rows for it yet — the ~30 s window the indexer takes on a big wallet.
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () =>
        json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a"] }),
      "/api/profile/collection-stats": () => json(200, { stats: [] }),
    })
    routes["/api/profile/saved-wallets"] = () =>
      json(200, {
        wallets: [
          {
            wallet_addr: "0xbd94cade097e50ac",
            collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
            username: "collector",
            display_name: null,
            nickname: null,
            cached_fmv: null,
            cached_moment_count: null,
            cached_top_tier: null,
            accent_color: null,
            pinned_at: "2026-09-04T04:00:00Z",
            verified_at: null,
            verification_method: null,
          },
        ],
      })
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.click(submit)
    await screen.findAllByText("Indexing your wallet…")
    const tiles = document.querySelector('[data-tour-anchor="portfolio-stats"]')!
    expect(tiles.textContent).not.toContain("$0")
    expect(tiles.textContent).toContain("—")
  })

  it("announces a newly-claimed profile handle only when the server says it claimed one", async () => {
    // ⚠ `profileHandleClaimed` is false on every RE-resolve, so refreshing a
    // collection must not re-announce a profile the collector has had for weeks.
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () =>
        json(200, {
          walletAddress: "0xbd94cade097e50ac",
          associatedCollections: ["a"],
          profileHandleClaimed: true,
          profileHandle: "collector",
        }),
    })
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.click(submit)
    await screen.findAllByText(/profile is live at \/profile\/collector/)
  })

  it("stays quiet about the handle on a re-resolve", async () => {
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () =>
        json(200, {
          walletAddress: "0xbd94cade097e50ac",
          associatedCollections: ["a"],
          profileHandleClaimed: false,
          profileHandle: "collector",
        }),
    })
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.click(submit)
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("resolve-and-associate"))).toBe(true))
    expect(screen.queryByText(/profile is live at/)).toBeNull()
  })

  it("surfaces the API's own message on a failed resolve", async () => {
    const { box, submit } = await openAddForm({
      "/api/profile/resolve-and-associate": () => json(404, { error: "No Top Shot account for that username" }),
    })
    fireEvent.change(box, { target: { value: "nobody" } })
    fireEvent.click(submit)
    await screen.findAllByText("No Top Shot account for that username")
  })

  it("falls back to the status when a failed resolve carries no message", async () => {
    const { box, submit } = await openAddForm({ "/api/profile/resolve-and-associate": () => json(503, {}) })
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.click(submit)
    await screen.findAllByText("HTTP 503")
  })

  it("routes a Solana address to Candy rather than to the Flow orchestrator", async () => {
    // ⚠ Candy is a different chain, and the Flow orchestrator takes a FLOW
    // address — handing it base58 would fan a Solana wallet across five Flow
    // surfaces it has no rows in.
    const { box, submit } = await openAddForm({
      "/api/profile/saved-wallets": () => json(200, { wallets: [] }),
    })
    fireEvent.change(box, { target: { value: "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY" } })
    fireEvent.click(submit)
    await waitFor(() => {
      const resolve = fetchMock.mock.calls.find((c) => String(c[0]).includes("resolve-and-associate"))
      expect(resolve).toBeUndefined()
    })
  })

  it("does NOT lowercase a base58 address — base58 is case-sensitive", async () => {
    // Lowercasing stores a mangled address that matches no
    // wallet_moments_cache row, and nothing on screen says so.
    const { box, submit } = await openAddForm({})
    const addr = "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"
    fireEvent.change(box, { target: { value: addr } })
    fireEvent.click(submit)
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "POST",
      )
      if (post) expect(String((post[1] as RequestInit).body)).toContain(addr)
    })
  })
})

// ─── The hero card ───────────────────────────────────────────────────────────

describe("DashboardClient — Friend Activity distinguishes empty from unreadable", () => {
  // Found 2026-08-26 by sweeping the WHOLE of refresh() rather than the one
  // panel that prompted the sweep — "fix per PANEL, not per page".
  //
  // A failed /api/profile/activity read leaves `activity` at [], and the empty
  // state then says "Follow other collectors to see their sales here … hit
  // + FOLLOW". That is the /my-teams "Follow a team to build your hub"
  // incident verbatim: a false claim about the reader's OWN account on a
  // signed-in surface, and ACTIONABLE — it tells someone who already follows
  // people to go and do it again.

  it("⚠ does NOT tell a collector to follow people when the activity read FAILED", async () => {
    routes["/api/profile/activity"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    // Assert the ABSENCE OF THE FALSE CLAIM, not the presence of an error.
    expect(screen.queryByText(/Follow other collectors/i)).toBeNull()
    expect(screen.getByText(/loading problem, not an empty feed/i)).toBeTruthy()
  })

  it("still prompts to follow when the read SUCCEEDS and the feed is genuinely empty", async () => {
    // NO-CHANGE CONTROL. Without it, deleting the prompt outright would satisfy
    // the test above while breaking the real empty state.
    routes["/api/profile/activity"] = () => json(200, { activity: [] })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.getByText(/Follow other collectors/i)).toBeTruthy()
    expect(screen.queryByText(/loading problem, not an empty feed/i)).toBeNull()
  })
})

describe("DashboardClient — the hero card", () => {
  const HERO = {
    momentId: "9001",
    collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    playerName: "Damian Lillard",
    setName: "Archive Set",
    tier: "LEGENDARY",
    serialNumber: 1,
    circulationCount: 99,
    fmv: 1250,
    imageUrl: null,
    isManualOverride: false,
  }

  async function withHero(over: Record<string, unknown> = {}) {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () => json(200, { hero: { ...HERO, ...over } })
    render(<DashboardClient />)
  }

  it("renders the hero moment when there are no trophies pinned", async () => {
    await withHero()
    await screen.findByText("Hero Moment")
    expect(document.body.textContent).toContain("Damian Lillard")
  })

  it("marks a manually-pinned hero as pinned", async () => {
    await withHero({ isManualOverride: true })
    await screen.findByText(/· pinned/)
  })

  it("does not claim a hero is pinned when it was auto-selected", async () => {
    await withHero({ isManualOverride: false })
    await screen.findByText("Hero Moment")
    expect(screen.queryByText(/· pinned/)).toBeNull()
  })

  it("renders a hero with no artwork without breaking the card", async () => {
    await withHero({ imageUrl: null, playerName: null })
    await screen.findByText("Hero Moment")
  })

  it("shows the onboarding prompt when there is genuinely no hero and no trophies", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () => json(200, { hero: null })
    render(<DashboardClient />)
    await screen.findByText(/Pin a moment to your trophy case/)
  })

  it("says it is indexing rather than prompting when a wallet was just added", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () => json(200, { hero: null })
    render(<DashboardClient />)
    await screen.findByText(/Pin a moment to your trophy case/)
  })

  it("survives a failed hero read without inventing a hero", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByText("Hero Moment")).toBeNull()
  })
})

// ─── Verify by listing ───────────────────────────────────────────────────────

const CHALLENGE = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  wallet_addr: "0xmine",
  challenge_amount: 1234.56,
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  resolved_at: null,
  resolved_via: null,
  matched_moment_id: null,
  target_moment_id: "9001",
  ...over,
})
const TARGET = { moment_id: "9001", player_name: "Damian Lillard", set_name: "Archive Set", serial_number: 12, tier: "COMMON" }

describe("DashboardClient — verify by listing", () => {
  async function openVerify(over: Record<string, unknown> = {}) {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
    Object.assign(routes, over)
    searchParams = new URLSearchParams("verify=0xmine")
    render(<DashboardClient />)
    return waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(true))
  }

  it("loads the active challenge and its target moment", async () => {
    await openVerify({
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    await screen.findByText(/1,234\.56|1234\.56/)
  })

  it("says verification is unavailable rather than showing a broken form", async () => {
    await openVerify({
      "/api/profile/verify-challenge": () =>
        json(200, { challenge: null, message: "No eligible Moment to list for this wallet." }),
    })
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(true))
  })

  it("⚠ distinguishes 'we could not check' from 'we checked and found nothing'", async () => {
    // The only self-serve verification path, and it awards credits. Before the
    // `res.ok` gate, a non-2xx still parsed, `d.ok` was undefined so the success
    // branch was skipped, and the hint rendered where a VERIFICATION RESULT
    // goes — telling a collector their listing was not found when we never
    // managed to look.
    let checks = 0
    await openVerify({
      "/api/profile/verify-challenge/check": () => { checks += 1; return json(503, {}) },
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    const btn = await screen.findByRole("button", { name: /I've listed it/ })
    fireEvent.click(btn)
    await screen.findByText(/says nothing about your listing/)
    expect(checks).toBe(1)
    expect(screen.queryByText(/No matching listing found yet/)).toBeNull()
  })

  it("reports a genuine miss as a real answer", async () => {
    await openVerify({
      "/api/profile/verify-challenge/check": () => json(200, { ok: true, matched: false }),
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await screen.findByText(/No matching listing found yet/)
  })

  it("prefers the server's own hint over the generic miss copy", async () => {
    await openVerify({
      "/api/profile/verify-challenge/check": () =>
        json(200, { ok: true, matched: false, hint: "Found it at $12.00 — relist at the exact amount." }),
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await screen.findByText(/relist at the exact amount/)
  })

  it("confirms verification only on a matched result", async () => {
    await openVerify({
      "/api/profile/verify-challenge/check": () => json(200, { ok: true, matched: true, moment: "9001" }),
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await screen.findByText(/Wallet verified/)
  })

  it("does not confirm on ok-without-matched", async () => {
    // ⚠ `ok` means the CHECK ran; `matched` means the listing was found. Reading
    // `ok` alone would award credits for a check that found nothing.
    await openVerify({
      "/api/profile/verify-challenge/check": () => json(200, { ok: true }),
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await waitFor(() => expect(screen.queryByText(/Wallet verified/)).toBeNull())
  })

  it("reports a thrown check as an error, not as a miss", async () => {
    await openVerify({
      "/api/profile/verify-challenge/check": () => { throw new Error("network down") },
      "/api/profile/verify-challenge": () => json(200, { challenge: CHALLENGE(), target: TARGET }),
    })
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await screen.findByText("network down")
  })

  it("surfaces a failure to START verification", async () => {
    await openVerify({ "/api/profile/verify-challenge": () => { throw new Error("mint failed") } })
    await waitFor(() => expect(document.body.textContent).toMatch(/mint failed|Failed to start verification/))
  })

  it("treats an already-resolved challenge as done", async () => {
    await openVerify({
      "/api/profile/verify-challenge": () =>
        json(200, { challenge: CHALLENGE({ resolved_at: new Date().toISOString() }), target: TARGET }),
    })
    await screen.findByText(/Wallet verified/)
  })
})

// ─── The hero picker modal ───────────────────────────────────────────────────

describe("DashboardClient — the hero picker", () => {
  const MOMENT = {
    moment_id: "9001",
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    player_name: "Damian Lillard",
    set_name: "Archive Set",
    tier: "RARE",
    serial_number: 12,
    circulation_count: 1000,
    image_url: null,
    fmv: 60,
  }

  async function openPicker(over: Record<string, unknown> = {}) {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: false } })
    Object.assign(routes, over)
    render(<DashboardClient />)
    const edit = await screen.findByRole("button", { name: /edit|change hero|set hero/i })
    fireEvent.click(edit)
    return screen.findByText("Set Hero Moment")
  }

  it("⚠ says the READ failed rather than claiming the collector owns no moments", async () => {
    // A claim about THEIR OWN COLLECTION manufactured from our outage.
    await openPicker({ "/api/profile/top-moments": () => json(503, {}) })
    await screen.findByText(/This says nothing about what you own/)
    expect(screen.queryByText("No owned moments found.")).toBeNull()
  })

  it("still says 'no owned moments' when the read SUCCEEDS with none", async () => {
    await openPicker({ "/api/profile/top-moments": () => json(200, { moments: [] }) })
    await screen.findByText("No owned moments found.")
    expect(screen.queryByText(/This says nothing about what you own/)).toBeNull()
  })

  it("treats a 200 with no moments key as a failed read, not an empty collection", async () => {
    await openPicker({ "/api/profile/top-moments": () => json(200, {}) })
    await screen.findByText(/This says nothing about what you own/)
  })

  it("reports a thrown read the same way", async () => {
    await openPicker({ "/api/profile/top-moments": () => { throw new Error("down") } })
    await screen.findByText(/This says nothing about what you own/)
  })

  it("renders the pickable moments", async () => {
    await openPicker({ "/api/profile/top-moments": () => json(200, { moments: [MOMENT] }) })
    await waitFor(() => expect(document.body.textContent).toContain("Archive Set"))
  })

  it("pins the picked moment", async () => {
    await openPicker({ "/api/profile/top-moments": () => json(200, { moments: [MOMENT] }) })
    await waitFor(() => expect(document.body.textContent).toContain("Archive Set"))
    const cards = Array.from(document.querySelectorAll("button")).filter((b) => /Archive Set/.test(b.textContent ?? ""))
    if (cards.length > 0) {
      fireEvent.click(cards[0])
      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          (c) => String(c[0]).includes("/api/profile/bio") && (c[1] as RequestInit)?.method === "PATCH",
        )
        expect(patch).toBeTruthy()
        expect(String((patch![1] as RequestInit).body)).toContain("heroMomentId")
      })
    }
  })
})

// ─── Reorder, undo and removal ───────────────────────────────────────────────

describe("DashboardClient — reorder, undo and removal", () => {
  function slabRoutes(n: number) {
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: Array.from({ length: n }, (_, i) =>
          SLAB({ id: i + 1, slot: i + 1, player_name: `Player ${i + 1}`, tier: i === 0 ? "COMMON" : "LEGENDARY", fmv: (i + 1) * 100 }),
        ),
      })
  }

  it("offers no arrange toolbar with fewer than two trophies", async () => {
    slabRoutes(1)
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: /Auto-Arrange/ })).toBeNull()
  })

  it("offers the arrange toolbar once two are pinned", async () => {
    slabRoutes(2)
    render(<DashboardClient />)
    await screen.findByRole("button", { name: /Auto-Arrange/ })
  })

  it("persists a new order and offers an undo", async () => {
    slabRoutes(3)
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Auto-Arrange/ }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("trophy/reorder"))
      expect(call).toBeTruthy()
    })
    await screen.findByText(/Arranged by/)
  })

  it("⚠ rolls the order back when the save fails", async () => {
    // Optimistic reflow with no rollback leaves the case looking rearranged
    // while the DB still holds the old order — the collector sees a change that
    // did not happen.
    slabRoutes(3)
    routes["/api/profile/trophy/reorder"] = () => json(503, { error: "reorder failed" })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Auto-Arrange/ }))
    await waitFor(() => expect(document.body.textContent).toMatch(/reorder failed|Failed/i))
    expect(screen.queryByText(/Arranged by/)).toBeNull()
  })

  it("undoes back to the previous order", async () => {
    slabRoutes(3)
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Auto-Arrange/ }))
    const undo = await screen.findByRole("button", { name: /undo/i })
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy/reorder")).length
    fireEvent.click(undo)
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy/reorder")).length).toBeGreaterThan(before),
    )
  })

  it("removes a trophy and confirms it", async () => {
    slabRoutes(2)
    routes["/api/profile/trophy"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByTestId("remove-slab-1"))
    await screen.findByText("Trophy removed")
  })

  it("⚠ restores the row when the removal fails", async () => {
    // Without the rollback the slot stays visually empty while the DB still
    // holds the trophy — the collector believes it is gone and it is not.
    slabRoutes(2)
    routes["/api/profile/trophy"] = () => json(503, { error: "could not unpin" })
    render(<DashboardClient />)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
    const before = screen.getAllByTestId("trophy-slab").length
    fireEvent.click(screen.getByTestId("remove-slab-1"))
    await screen.findByText("could not unpin")
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBe(before))
    expect(screen.getByTestId("remove-slab-1")).toBeTruthy()
  })
})

// ─── The advanced add-wallet form ────────────────────────────────────────────

describe("DashboardClient — the advanced add-wallet form", () => {
  /**
   * ⚠ Real labels, no `if (btn)` guard. Every guarded click in the first draft
   * of this file passed while asserting NOTHING — `addWallet` and
   * `handleRemoveTrophy` were both measured as uncovered until the guesses were
   * replaced with the labels the page really renders.
   */
  async function openAdvanced() {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await revealSectionForm()
    await screen.findByPlaceholderText("Dapper username")
    fireEvent.click(screen.getAllByRole("button", { name: "Advanced: enter wallet address directly" })[0])
    const addr = (await screen.findAllByPlaceholderText("0x… wallet address"))[0]
    const save = addr.closest("div")!.querySelector("button")!
    return { addr, save }
  }

  it("refuses an empty address", async () => {
    const { save } = await openAdvanced()
    const before = fetchMock.mock.calls.length
    fireEvent.click(save)
    await screen.findAllByText("Address required")
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it("posts the address with its nickname and collection", async () => {
    const { addr, save } = await openAdvanced()
    fireEvent.change(addr, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.change(screen.getAllByPlaceholderText("Nickname (optional)")[0], { target: { value: "main" } })
    fireEvent.click(save)
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "POST",
      )
      expect(post).toBeTruthy()
      const body = String((post![1] as RequestInit).body)
      expect(body).toContain("0xbd94cade097e50ac")
      expect(body).toContain("main")
      expect(body).toContain("collectionId")
    })
  })

  it("surfaces the API's own message on a failed save", async () => {
    // ⚠ Override AFTER openAdvanced — it sets this route itself to produce the
    // empty-wallets state the form needs, so overriding first is undone.
    const { addr, save } = await openAdvanced()
    routes["/api/profile/saved-wallets"] = () => json(409, { error: "That wallet is already saved" })
    fireEvent.change(addr, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(save)
    await screen.findAllByText("That wallet is already saved")
  })

  it("falls back to the status when a failed save carries no message", async () => {
    const { addr, save } = await openAdvanced()
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    fireEvent.change(addr, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(save)
    await screen.findAllByText("HTTP 503")
  })

  it("sends no nickname rather than an empty string when none was typed", async () => {
    // An empty string and "no nickname" are different states in the DB.
    const { addr, save } = await openAdvanced()
    fireEvent.change(addr, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(save)
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "POST",
      )
      expect(String((post![1] as RequestInit).body)).toContain('"nickname":null')
    })
  })
})

// ─── Stats retry and the indexing poll ───────────────────────────────────────

describe("DashboardClient — stats retry and the indexing poll", () => {
  it("⚠ retries a transient stats 503 once before recording a failure", async () => {
    // The stats RPC transiently 503s under DB contention on whale wallets. A
    // silent skip zeroes the WHOLE portfolio tile (false $0), so it retries with
    // a small backoff before giving up — and only THEN renders "—".
    vi.useFakeTimers()
    try {
      let calls = 0
      routes["/api/profile/collection-stats"] = () => {
        calls += 1
        return calls === 1 ? json(503, {}) : json(200, { stats: [] })
      }
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(1200)
      expect(calls).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up after the retry rather than retrying forever", async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      routes["/api/profile/collection-stats"] = () => { calls += 1; return json(503, {}) }
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(1200)
      const afterRetry = calls
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toBe(afterRetry)
    } finally {
      vi.useRealTimers()
    }
  })

  it("coerces non-numeric stat fields rather than rendering NaN", async () => {
    routes["/api/profile/collection-stats"] = () =>
      json(200, {
        stats: [
          {
            collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
            collection_slug: "nba-top-shot",
            collection_label: "NBA Top Shot",
            moment_count: "42",
            fmv_total: null,
            fmv_stale_total: undefined,
            stale_count: "x",
          },
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(document.body.textContent).not.toMatch(/NaN/)
  })

  it("polls for saved wallets after a wallet is added, then stops", async () => {
    vi.useFakeTimers()
    try {
      routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
      routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
      routes["/api/profile/resolve-and-associate"] = () =>
        json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a"] })
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(50)
      {
        const reveal = screen.queryByRole("button", { name: /add one here/i })
        if (reveal) fireEvent.click(reveal)
      }
      const box = screen.getAllByPlaceholderText("Dapper username")[0]
      const submit = box.closest("div")!.querySelector("button")!
      fireEvent.change(box, { target: { value: "collector" } })
      fireEvent.click(submit)
      await vi.advanceTimersByTimeAsync(200)
      const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("saved-wallets")).length
      // ⚠ The poll interval is 10s and the safety ceiling is 60s — advancing
      // 6s observes nothing and reads as "the poll never started".
      await vi.advanceTimersByTimeAsync(11_000)
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("saved-wallets")).length).toBeGreaterThan(before)
      // ⚠ And it must STOP — a poll with no ceiling keeps querying a whale
      // wallet forever if the indexer never reports done.
      await vi.advanceTimersByTimeAsync(120_000)
      const settled = fetchMock.mock.calls.filter((c) => String(c[0]).includes("saved-wallets")).length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("saved-wallets")).length).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it("survives a failed poll tick without stopping the dashboard", async () => {
    vi.useFakeTimers()
    try {
      routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
      routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
      routes["/api/profile/resolve-and-associate"] = () =>
        json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a"] })
      render(<DashboardClient />)
      // ⚠ Two advances. The first render commits before the initial refresh's
      // promise chain settles, so the add-wallet form is not mounted yet and a
      // single 50ms advance finds no input — which reads as a missing element
      // rather than as a timing problem.
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
      {
        const reveal = screen.queryByRole("button", { name: /add one here/i })
        if (reveal) fireEvent.click(reveal)
      }
      const box = screen.getAllByPlaceholderText("Dapper username")[0]
      fireEvent.change(box, { target: { value: "collector" } })
      fireEvent.click(box.closest("div")!.querySelector("button")!)
      await vi.advanceTimersByTimeAsync(200)
      routes["/api/profile/saved-wallets"] = () => json(503, {})
      await vi.advanceTimersByTimeAsync(22_000)
      expect(document.body.textContent).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── Edit-layout mode and drag reorder ───────────────────────────────────────

describe("DashboardClient — edit-layout mode", () => {
  function slabRoutes(n: number) {
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: Array.from({ length: n }, (_, i) =>
          SLAB({ id: i + 1, slot: i + 1, player_name: `Player ${i + 1}`, fmv: (i + 1) * 100 }),
        ),
      })
  }

  it("enters and leaves edit mode", async () => {
    slabRoutes(3)
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    await screen.findByRole("button", { name: "Done" })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await screen.findByRole("button", { name: "Edit Layout" })
  })

  it("Escape leaves edit mode", async () => {
    // ⚠ A modal-ish mode with no keyboard exit strands a keyboard user in it.
    slabRoutes(3)
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    await screen.findByRole("button", { name: "Done" })
    fireEvent.keyDown(window, { key: "Escape" })
    await screen.findByRole("button", { name: "Edit Layout" })
  })

  it("ignores other keys", async () => {
    slabRoutes(3)
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    await screen.findByRole("button", { name: "Done" })
    fireEvent.keyDown(window, { key: "x" })
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy()
  })

  it("reorders by drag and persists the new order", async () => {
    slabRoutes(3)
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    const { container } = render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    await screen.findByRole("button", { name: "Done" })
    const draggables = container.querySelectorAll('[draggable="true"]')
    expect(draggables.length).toBeGreaterThan(1)
    const dt = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "1" }
    fireEvent.dragStart(draggables[0], { dataTransfer: dt })
    fireEvent.dragOver(draggables[2], { dataTransfer: dt })
    fireEvent.drop(draggables[2], { dataTransfer: dt })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("trophy/reorder"))).toBe(true)
    })
  })

  it("clears the drop indicator on drag leave and drag end", async () => {
    slabRoutes(3)
    const { container } = render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    await screen.findByRole("button", { name: "Done" })
    const draggables = container.querySelectorAll('[draggable="true"]')
    const dt = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "1" }
    fireEvent.dragStart(draggables[0], { dataTransfer: dt })
    fireEvent.dragOver(draggables[1], { dataTransfer: dt })
    fireEvent.dragLeave(draggables[1], { dataTransfer: dt })
    fireEvent.dragEnd(draggables[0], { dataTransfer: dt })
    expect(container.querySelectorAll('[draggable="true"]').length).toBeGreaterThan(1)
  })

  it("does not persist when the arrange produces the order already on screen", async () => {
    // ⚠ Persisting a no-op order costs a write and offers an "undo" for a
    // change that never happened.
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: [
          SLAB({ id: 1, slot: 1, player_name: "A", fmv: 900, tier: "LEGENDARY" }),
          SLAB({ id: 2, slot: 2, player_name: "B", fmv: 100, tier: "COMMON" }),
        ],
      })
    // ⚠ THE ASSERTION IS AGAINST ZERO, NOT AGAINST A BASELINE THIS TEST TOOK OF
    // ITSELF. The earlier version captured `reorders` from the same expression
    // it later compared to, so if the first click DID persist and the request
    // simply had not landed inside a 40ms real-time sleep, the baseline
    // recorded 0 and the comparison was satisfied by the defect — the
    // self-referential-comparison vacuity shape, where a mutation changes both
    // sides. The fixture is already sorted by fmv desc, so the honest claim is
    // absolute: an arrange that changes nothing writes NOTHING, ever.
    render(<DashboardClient />)
    const arrange = await screen.findByRole("button", { name: /Auto-Arrange/ })
    const reorderCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy/reorder")).length
    fireEvent.click(arrange)
    await new Promise((r) => setTimeout(r, 40))
    expect(reorderCalls()).toBe(0)
    fireEvent.click(arrange)
    await new Promise((r) => setTimeout(r, 40))
    expect(reorderCalls()).toBe(0)
  })
})

// ─── Clearing the hero ───────────────────────────────────────────────────────

describe("DashboardClient — clearing the hero", () => {
  async function openPicker() {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: true } })
    routes["/api/profile/top-moments"] = () => json(200, { moments: [] })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /edit|change hero|set hero/i }))
    return screen.findByText("Set Hero Moment")
  }

  it("clears the pinned hero back to automatic", async () => {
    await openPicker()
    const clear = Array.from(document.querySelectorAll("button")).find((b) => /^clear/i.test(b.textContent?.trim() ?? ""))
    expect(clear).toBeTruthy()
    fireEvent.click(clear!)
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/profile/bio") && (c[1] as RequestInit)?.method === "PATCH",
      )
      expect(patch).toBeTruthy()
      expect(String((patch![1] as RequestInit).body)).toContain('"heroMomentId":null')
    })
  })

  it("reports a failed clear rather than silently doing nothing", async () => {
    await openPicker()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/api/profile/bio") && init?.method === "PATCH") throw new Error("clear failed")
      return json(200, {})
    })
    const clear = Array.from(document.querySelectorAll("button")).find((b) => /^clear/i.test(b.textContent?.trim() ?? ""))
    fireEvent.click(clear!)
    await screen.findByText("clear failed")
  })

  it("reports a failed pin", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: false } })
    routes["/api/profile/top-moments"] = () =>
      json(200, {
        moments: [{ moment_id: "9001", collection_id: "c", player_name: "Damian Lillard", set_name: "Archive Set", tier: "RARE", serial_number: 12, circulation_count: 1000, image_url: null, fmv: 60 }],
      })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /edit|change hero|set hero/i }))
    await screen.findByText("Set Hero Moment")
    await waitFor(() => expect(document.body.textContent).toContain("Archive Set"))
    routes["/api/profile/bio"] = () => json(503, { error: "could not pin" })
    const card = Array.from(document.querySelectorAll("button")).find((b) => /Archive Set/.test(b.textContent ?? ""))
    fireEvent.click(card!)
    await screen.findByText("could not pin")
  })
})

// ─── Wallet card actions and favourites ──────────────────────────────────────

describe("DashboardClient — wallet card actions and favourites", () => {
  it("removes a saved wallet by address, then reloads", async () => {
    render(<DashboardClient />)
    const remove = await screen.findByRole("button", { name: "Remove saved wallet" })
    fireEvent.click(remove)
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "DELETE",
      )
      expect(del).toBeTruthy()
      expect(String((del![1] as RequestInit).body)).toContain("0xmine")
    })
  })

  it("opens the verify modal from the wallet card", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Verify by listing/ }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(true),
    )
  })

  it("favourites a collection", async () => {
    render(<DashboardClient />)
    await screen.findByText("Favorite Collections")
    const chips = Array.from(document.querySelectorAll("button")).filter((b) => /Top Shot|All Day|Golazos/i.test(b.textContent ?? ""))
    expect(chips.length).toBeGreaterThan(0)
    fireEvent.click(chips[0])
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/profile/favorites") && (c[1] as RequestInit)?.method === "POST",
      )
      expect(post).toBeTruthy()
    })
  })

  it("un-favourites an already-favourited collection with a DELETE", async () => {
    // ⚠ The method is derived from current state, so a wrong read of `isFav`
    // silently makes the chip a one-way toggle.
    routes["/api/profile/favorites"] = () =>
      json(200, { favorites: [{ collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", favorited: true }] })
    render(<DashboardClient />)
    await screen.findByText("Favorite Collections")
    const chips = Array.from(document.querySelectorAll("button")).filter((b) => /Top Shot/i.test(b.textContent ?? ""))
    fireEvent.click(chips[0])
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/profile/favorites") && (c[1] as RequestInit)?.method === "DELETE",
      )
      expect(del).toBeTruthy()
    })
  })

  it("confirms a pin and reloads when the picker reports one", async () => {
    searchParams = new URLSearchParams("pin=2")
    render(<DashboardClient />)
    expect(await screen.findByTestId("trophy-picker")).toBeTruthy()
  })
})

// ─── Portfolio totals ────────────────────────────────────────────────────────

describe("DashboardClient — portfolio totals", () => {
  function withStats(stats: Array<Record<string, unknown>>) {
    routes["/api/profile/collection-stats"] = () => json(200, { stats })
  }

  it("sums moments and FMV across collections", async () => {
    withStats([
      { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", collection_slug: "nba-top-shot", collection_label: "NBA Top Shot", moment_count: 40, fmv_total: 1000, fmv_stale_total: 0, stale_count: 0 },
      { collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", collection_slug: "nfl-all-day", collection_label: "NFL All Day", moment_count: 2, fmv_total: 234, fmv_stale_total: 0, stale_count: 0 },
    ])
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/42/))
  })

  it("keeps STALE FMV out of the headline but discloses it", async () => {
    // ⚠ A STALE price has not refreshed recently and over/under-states the
    // holding, so it is excluded from the headline — but silently dropping it
    // would understate the portfolio with nothing on screen to say so.
    withStats([
      { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", collection_slug: "nba-top-shot", collection_label: "NBA Top Shot", moment_count: 40, fmv_total: 1000, fmv_stale_total: 500, stale_count: 7 },
    ])
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/stale/i))
  })

  it("renders an em-dash rather than a $0 when the read failed", async () => {
    routes["/api/profile/collection-stats"] = () => json(503, {})
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("collection-stats"))).toBe(true))
    await waitFor(() => expect(document.body.textContent).toContain("—"))
  })

  it("counts only collections the wallet actually holds moments in", async () => {
    withStats([
      { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", collection_slug: "nba-top-shot", collection_label: "NBA Top Shot", moment_count: 40, fmv_total: 1000, fmv_stale_total: 0, stale_count: 0 },
      { collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", collection_slug: "nfl-all-day", collection_label: "NFL All Day", moment_count: 0, fmv_total: 0, fmv_stale_total: 0, stale_count: 0 },
    ])
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/40/))
  })
})

// ─── Form affordances and keyboard paths ─────────────────────────────────────

describe("DashboardClient — form affordances and keyboard paths", () => {
  it("reopens the add-wallet form from the wallets section", async () => {
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "+ Add another wallet" }))
    await screen.findByPlaceholderText("Dapper username")
  })

  it("submits the identifier on Enter", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/resolve-and-associate"] = () =>
      json(200, { walletAddress: "0xbd94cade097e50ac", associatedCollections: ["a"] })
    render(<DashboardClient />)
    await revealSectionForm()
    const box = (await screen.findAllByPlaceholderText("Dapper username"))[0]
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("resolve-and-associate"))).toBe(true),
    )
  })

  it("ignores other keys in the identifier field", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await revealSectionForm()
    const box = (await screen.findAllByPlaceholderText("Dapper username"))[0]
    fireEvent.change(box, { target: { value: "collector" } })
    fireEvent.keyDown(box, { key: "a" })
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("resolve-and-associate"))).toBe(false)
  })

  it("hides the advanced form again and clears its error", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await revealSectionForm()
    await screen.findByPlaceholderText("Dapper username")
    fireEvent.click(screen.getAllByRole("button", { name: "Advanced: enter wallet address directly" })[0])
    const save = (await screen.findAllByPlaceholderText("0x… wallet address"))[0].closest("div")!.querySelector("button")!
    fireEvent.click(save)
    await screen.findAllByText("Address required")
    fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[0])
    await waitFor(() => expect(screen.queryByText("Address required")).toBeNull())
  })

  it("lets the advanced form target a specific collection", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await revealSectionForm()
    await screen.findByPlaceholderText("Dapper username")
    fireEvent.click(screen.getAllByRole("button", { name: "Advanced: enter wallet address directly" })[0])
    const addr = (await screen.findAllByPlaceholderText("0x… wallet address"))[0]
    const select = addr.closest("div")!.querySelector("select")!
    fireEvent.change(select, { target: { value: "nfl-all-day" } })
    fireEvent.change(addr, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(addr.closest("div")!.querySelector("button")!)
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "POST",
      )
      // ⚠ The All Day UUID, not Top Shot's — sending the default would file the
      // wallet under a collection the collector did not choose.
      expect(String((post![1] as RequestInit).body)).toContain("dee28451-5d62-409e-a1ad-a83f763ac070")
    })
  })

  it("cancels out of the add-wallet form", async () => {
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "+ Add another wallet" }))
    await screen.findByPlaceholderText("Dapper username")
    const cancel = Array.from(document.querySelectorAll("button")).find((b) => /^cancel$/i.test(b.textContent?.trim() ?? ""))
    expect(cancel).toBeTruthy()
    fireEvent.click(cancel!)
    await waitFor(() => expect(screen.queryByPlaceholderText("Dapper username")).toBeNull())
  })

  it("offers a pick-a-moment CTA when nothing is pinned", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () => json(200, { hero: null })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "+ Pick a moment" }))
    expect(await screen.findByTestId("trophy-picker")).toBeTruthy()
  })

  it("changes the auto-arrange sort key", async () => {
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: [
          SLAB({ id: 1, slot: 1, player_name: "A", fmv: 100, tier: "COMMON" }),
          SLAB({ id: 2, slot: 2, player_name: "B", fmv: 900, tier: "LEGENDARY" }),
        ],
      })
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    const select = await screen.findByLabelText("Auto-arrange sort order")
    fireEvent.change(select, { target: { value: "rarity" } })
    fireEvent.click(screen.getByRole("button", { name: /Auto-Arrange/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("trophy/reorder"))).toBe(true))
  })

  it("Escape closes a modal", async () => {
    // ⚠ A modal with no keyboard exit traps a keyboard user inside it.
    searchParams = new URLSearchParams("pin=1")
    render(<DashboardClient />)
    await screen.findByTestId("trophy-picker")
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("falls back to a placeholder when hero artwork fails to load", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: "https://assets.nbatopshot.com/x.jpg", isManualOverride: false } })
    const { container } = render(<DashboardClient />)
    await screen.findByText("Hero Moment")
    const img = container.querySelector("img")
    expect(img).toBeTruthy()
    fireEvent.error(img!)
    await waitFor(() => expect(screen.getByText("Hero Moment")).toBeTruthy())
  })
})

// ─── Recovery affordances ────────────────────────────────────────────────────

describe("DashboardClient — recovery affordances", () => {
  it("offers a retry beside the em-dash when the stats read failed", async () => {
    // ⚠ Rendering "—" without a way back leaves the collector with a dashboard
    // that will not recover until they reload — the retry is what makes the
    // honest failure state actionable rather than terminal.
    let calls = 0
    routes["/api/profile/collection-stats"] = () => { calls += 1; return json(503, {}) }
    render(<DashboardClient />)
    // ⚠ The failure is only RECORDED after the built-in 800ms retry gives up,
    // so the Retry affordance does not exist for the first second. Waiting only
    // for the first call reads as "the button was never rendered".
    const retry = await waitFor(
      () => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => /^retry$/i.test(x.textContent?.trim() ?? ""))
        expect(b).toBeTruthy()
        return b!
      },
      { timeout: 4000 },
    )
    const before = calls
    fireEvent.click(retry)
    await waitFor(() => expect(calls).toBeGreaterThan(before))
  })

  it("recovers the real figures when the retry succeeds", async () => {
    // ⚠ Flip the route AFTER the failure state is on screen. Encoding the flip
    // as a call-count threshold couples the test to how many attempts the
    // built-in backoff makes, and it timed out when that assumption was off by
    // one — a test measuring the implementation's retry count, not the recovery.
    routes["/api/profile/collection-stats"] = () => json(503, {})
    render(<DashboardClient />)
    const retry = await waitFor(
      () => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => /^retry$/i.test(x.textContent?.trim() ?? ""))
        expect(b).toBeTruthy()
        return b!
      },
      { timeout: 4000 },
    )
    routes["/api/profile/collection-stats"] = () =>
      json(200, {
        stats: [
          { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", collection_slug: "nba-top-shot", collection_label: "NBA Top Shot", moment_count: 77, fmv_total: 1000, fmv_stale_total: 0, stale_count: 0 },
        ],
      })
    fireEvent.click(retry)
    await waitFor(() => expect(document.body.textContent).toMatch(/77/), { timeout: 4000 })
  })

  it("moves a trophy left and right with the keyboard-reachable buttons", async () => {
    // ⚠ Drag-and-drop alone is unreachable for a keyboard or touch user, so the
    // arrow buttons are the accessible path to the same reorder.
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: [
          SLAB({ id: 1, slot: 1, player_name: "A" }),
          SLAB({ id: 2, slot: 2, player_name: "B" }),
          SLAB({ id: 3, slot: 3, player_name: "C" }),
        ],
      })
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    const right = await screen.findByRole("button", { name: /Move A right/i })
    fireEvent.click(right)
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("trophy/reorder"))).toBe(true))
    const left = await screen.findByRole("button", { name: /Move A left/i })
    expect((left as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(left)
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy/reorder")).length).toBeGreaterThan(1),
    )
  })

  it("disables the left arrow on the first trophy", async () => {
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, { slabs: [SLAB({ id: 1, slot: 1, player_name: "A" }), SLAB({ id: 2, slot: 2, player_name: "B" })] })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: "Edit Layout" }))
    const left = await screen.findByRole("button", { name: /Move A left/i })
    expect((left as HTMLButtonElement).disabled).toBe(true)
  })

  it("dismisses the undo bar", async () => {
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, {
        slabs: [
          SLAB({ id: 1, slot: 1, player_name: "A", fmv: 100 }),
          SLAB({ id: 2, slot: 2, player_name: "B", fmv: 900 }),
        ],
      })
    routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /Auto-Arrange/ }))
    await screen.findByText(/Arranged by/)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(screen.queryByText(/Arranged by/)).toBeNull())
  })

  it("the undo bar times itself out", async () => {
    vi.useFakeTimers()
    try {
      routes["/api/profile/trophy-slabs"] = () =>
        json(200, {
          slabs: [
            SLAB({ id: 1, slot: 1, player_name: "A", fmv: 100 }),
            SLAB({ id: 2, slot: 2, player_name: "B", fmv: 900 }),
          ],
        })
      routes["/api/profile/trophy/reorder"] = () => json(200, { ok: true })
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(100)
      fireEvent.click(screen.getByRole("button", { name: /Auto-Arrange/ }))
      await vi.advanceTimersByTimeAsync(100)
      expect(document.body.textContent).toMatch(/Arranged by/)
      await vi.advanceTimersByTimeAsync(6000)
      await vi.advanceTimersByTimeAsync(100)
      expect(document.body.textContent).not.toMatch(/Arranged by/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts the challenge expiry down", async () => {
    vi.useFakeTimers()
    try {
      routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
      routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
      searchParams = new URLSearchParams("verify=0xmine")
      render(<DashboardClient />)
      await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(100)
      const first = document.body.textContent ?? ""
      await vi.advanceTimersByTimeAsync(3000)
      expect(document.body.textContent).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it("says Candy is not available yet rather than silently doing nothing", async () => {
    // ⚠ CURRENT BEHAVIOUR, pinned as such. `candy-mlb` is UNPUBLISHED, so
    // `getPublishedCollection("candy-mlb")` returns undefined and the Solana
    // branch throws before it ever POSTs. A collector who pastes a Candy
    // address gets a reason, not a dead button — and when Candy publishes,
    // this test is what tells you the branch changed.
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await revealSectionForm()
    const box = (await screen.findAllByPlaceholderText("Dapper username"))[0]
    fireEvent.change(box, { target: { value: "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY" } })
    fireEvent.click(box.closest("div")!.querySelector("button")!)
    await screen.findAllByText(/Candy isn.t available yet/)
    expect(
      fetchMock.mock.calls.some(
        (c) => String(c[0]).includes("saved-wallets") && (c[1] as RequestInit)?.method === "POST",
      ),
    ).toBe(false)
  })
})

// ─── Modal callbacks ─────────────────────────────────────────────────────────

describe("DashboardClient — modal callbacks", () => {
  it("closes the pin modal", async () => {
    searchParams = new URLSearchParams("pin=1")
    render(<DashboardClient />)
    await screen.findByTestId("trophy-picker")
    fireEvent.click(screen.getByTestId("picker-close"))
    await waitFor(() => expect(screen.queryByTestId("trophy-picker")).toBeNull())
  })

  it("confirms a pin, reloads, and closes", async () => {
    searchParams = new URLSearchParams("pin=1")
    render(<DashboardClient />)
    await screen.findByTestId("trophy-picker")
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy-slabs")).length
    fireEvent.click(screen.getByTestId("picker-pinned"))
    await screen.findByText("Trophy pinned")
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("trophy-slabs")).length).toBeGreaterThan(before),
    )
    expect(screen.queryByTestId("trophy-picker")).toBeNull()
  })

  it("⚠ names the trophy a pin will REPLACE by its own slot, not by array position", async () => {
    // Filled slabs pack to the FRONT while `slot` is the persisted column, so
    // indexing by `slot - 1` names the wrong Moment — and this feeds a
    // DESTRUCTIVE confirmation, where naming the wrong trophy is worse than
    // naming none.
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, { slabs: [SLAB({ id: 1, slot: 1, player_name: "First" }), SLAB({ id: 3, slot: 3, player_name: "Third" })] })
    searchParams = new URLSearchParams("pin=3")
    render(<DashboardClient />)
    const picker = await screen.findByTestId("trophy-picker")
    await waitFor(() => expect(picker.getAttribute("data-replacing")).toBe("Third"))
  })

  it("names nothing when the target slot is empty", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [SLAB({ id: 1, slot: 1, player_name: "First" })] })
    searchParams = new URLSearchParams("pin=4")
    render(<DashboardClient />)
    const picker = await screen.findByTestId("trophy-picker")
    await waitFor(() => expect(picker.getAttribute("data-replacing")).toBe(""))
  })

  it("reflects a saved caption onto the right slab", async () => {
    // ⚠ Matched on the slab's OWN `slot`, never on array position — after a
    // reorder the two diverge and the caption lands on the wrong Moment.
    routes["/api/profile/trophy-slabs"] = () =>
      json(200, { slabs: [SLAB({ id: 1, slot: 1, player_name: "First" }), SLAB({ id: 3, slot: 3, player_name: "Third" })] })
    render(<DashboardClient />)
    const editor = await screen.findByTestId("note-editor-3")
    fireEvent.click(editor)
    await waitFor(() => expect(screen.getAllByTestId("trophy-slab").length).toBeGreaterThan(0))
  })

  it("closes the hero editor without pinning", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: false } })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /edit|change hero|set hero/i }))
    await screen.findByText("Set Hero Moment")
    // ⚠ By aria-label. Matching the ✕ GLYPH as text is brittle and the `if
    // (close)` guard around it would have passed silently when it did not match.
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByText("Set Hero Moment")).toBeNull())
  })

  it("clicking the backdrop closes the modal, clicking inside does not", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: false } })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /edit|change hero|set hero/i }))
    const title = await screen.findByText("Set Hero Moment")
    // Inside first — a modal that closes on its own content is unusable.
    fireEvent.click(title)
    expect(screen.getByText("Set Hero Moment")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByText("Set Hero Moment")).toBeNull())
  })

  it("closes the verify modal without verifying", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    searchParams = new URLSearchParams("verify=0xmine")
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(true))
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(document.body.textContent).toBeTruthy())
  })

  it("confirms verification and reloads", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [WALLET({ verified_at: null })] })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    routes["/api/profile/verify-challenge/check"] = () => json(200, { ok: true, matched: true, moment: "9001" })
    searchParams = new URLSearchParams("verify=0xmine")
    render(<DashboardClient />)
    // ⚠ SYNCHRONISE ON THE CHALLENGE FETCH BEFORE QUERYING FOR THE BUTTON.
    // Without this the case races `findByRole`'s 1000ms default against render
    // + the verify-challenge round trip, which is comfortable in isolation and
    // NOT comfortable inside the full 231-file component run — it was the sole
    // failure of that suite on `main`, passing every time the file ran alone.
    // That shape (green solo, red in the suite) reads like a flake and is a
    // missing await: every sibling in this file already waits here, either via
    // the `openVerify` helper or, as in the test directly above, this exact
    // line. Widening the timeout would only make the race slower to lose.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(true),
    )
    fireEvent.click(await screen.findByRole("button", { name: /I've listed it/ }))
    await screen.findByText(/Wallet verified/)
  })
})

// ─── Shapes the API really produces ──────────────────────────────────────────

describe("DashboardClient — shapes the API really produces", () => {
  it("targets the exact wallet named by ?verify=", async () => {
    routes["/api/profile/saved-wallets"] = () =>
      json(200, {
        wallets: [WALLET({ id: "w-1", wallet_addr: "0xother", verified_at: null }), WALLET({ id: "w-2", wallet_addr: "0xmine", verified_at: null })],
      })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    searchParams = new URLSearchParams("verify=0xmine")
    render(<DashboardClient />)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("verify-challenge?"))
      expect(call).toBeTruthy()
      expect(String(call![0])).toContain("0xmine")
    })
  })

  it("falls back to the first UNVERIFIED wallet when ?verify= names no known address", async () => {
    // ⚠ Falling back to `wallets[0]` regardless would open the verify flow on a
    // wallet the collector has already verified — busywork presented as a task.
    routes["/api/profile/saved-wallets"] = () =>
      json(200, {
        wallets: [WALLET({ id: "w-1", wallet_addr: "0xverified", verified_at: new Date().toISOString() }), WALLET({ id: "w-2", wallet_addr: "0xunverified", verified_at: null })],
      })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    searchParams = new URLSearchParams("verify=1")
    render(<DashboardClient />)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("verify-challenge?"))
      expect(String(call![0])).toContain("0xunverified")
    })
  })

  it("falls back to the first wallet when every one is already verified", async () => {
    routes["/api/profile/saved-wallets"] = () =>
      json(200, { wallets: [WALLET({ wallet_addr: "0xonly", verified_at: new Date().toISOString() })] })
    routes["/api/profile/verify-challenge"] = () => json(200, { challenge: CHALLENGE(), target: TARGET })
    searchParams = new URLSearchParams("verify=1")
    render(<DashboardClient />)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("verify-challenge?"))
      expect(String(call![0])).toContain("0xonly")
    })
  })

  it("does nothing with ?verify= when no wallets are saved", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    searchParams = new URLSearchParams("verify=0xmine")
    render(<DashboardClient />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("verify-challenge"))).toBe(false)
  })

  it("names an anonymous actor rather than rendering a blank activity line", async () => {
    routes["/api/profile/activity"] = () =>
      json(200, {
        activity: [
          { followee_username: null, role: "buyer", player_name: null, serial_number: null, thumbnail_url: null, price_usd: 40, created_at: new Date().toISOString() },
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/someone/))
    expect(document.body.textContent).toMatch(/a moment/)
  })

  it("says sold for a seller and bought for a buyer", async () => {
    routes["/api/profile/activity"] = () =>
      json(200, {
        activity: [
          { followee_username: "friend", role: "seller", player_name: "Damian Lillard", serial_number: 12, thumbnail_url: "https://x/y.png", price_usd: 40, created_at: new Date().toISOString() },
          { followee_username: "other", role: "buyer", player_name: "CJ McCollum", serial_number: null, thumbnail_url: null, price_usd: 20, created_at: new Date().toISOString() },
        ],
      })
    render(<DashboardClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/sold/))
    expect(document.body.textContent).toMatch(/bought/)
    expect(document.body.textContent).toContain("#12")
  })

  it("renders picker cards for moments with and without art, serials and locks", async () => {
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    routes["/api/profile/hero-moment"] = () =>
      json(200, { hero: { momentId: "9001", collectionId: "c", playerName: "Damian Lillard", setName: "Archive Set", tier: "RARE", serialNumber: 12, circulationCount: 1000, fmv: 60, imageUrl: null, isManualOverride: false } })
    routes["/api/profile/top-moments"] = () =>
      json(200, {
        moments: [
          { moment_id: "1", collection_id: "c", player_name: "Damian Lillard", set_name: "Archive Set", tier: "RARE", serial_number: 12, mint_count: 1000, image_url: "https://x/y.png", fmv: 60, is_locked: true },
          { moment_id: "2", collection_id: "c", player_name: null, set_name: null, tier: null, serial_number: null, mint_count: null, image_url: null, fmv: null, is_locked: false },
        ],
      })
    render(<DashboardClient />)
    fireEvent.click(await screen.findByRole("button", { name: /edit|change hero|set hero/i }))
    await screen.findByText("Set Hero Moment")
    await waitFor(() => expect(document.body.textContent).toContain("Archive Set"))
    // ⚠ The unnamed moment falls back to its ID rather than rendering a blank
    // tile the collector cannot identify or choose.
    expect(document.body.textContent).toContain("#12/1000")
    expect(screen.getByLabelText("Locked")).toBeTruthy()
  })
})

// ─── Slot-vs-position: a SOURCE assertion, and why ───────────────────────────

describe("DashboardClient — slot is read from the slab, never from array position", () => {
  /**
   * ⚠ TWO MUTATIONS SURVIVED HERE AND THAT IS THE CORRECT OUTCOME, not a gap.
   *
   * `occupantOfSlot(slabs, pinSlot)` and `slabs[pinSlot - 1]` are INDISTINGUISHABLE
   * given every state this page can currently produce: `refresh()` writes each
   * slab at `next[s.slot - 1]`, and `handleReorderTrophies` writes
   * `next[i] = { ...s, slot: i + 1 }` — both keep array position and the
   * persisted `slot` aligned. The same holds for `s.slot === slot` versus
   * `i === slot - 1` in the caption sync.
   *
   * Contriving a divergent fixture would assert a state the app cannot reach.
   * What makes the distinction load-bearing is a FUTURE write path that packs
   * filled slabs to the front WITHOUT renumbering — which is exactly the shape
   * `lib/trophy/reorder.ts` documents, and why `occupantOfSlot` exists. Until
   * such a path lands, the honest instrument is the source: assert the page
   * still asks by SLOT, so a refactor that reintroduces indexing has to do it
   * deliberately.
   *
   * The stakes are why this is asserted at all rather than dropped: the
   * replacing-name feeds a DESTRUCTIVE confirmation ("this replaces X"), and
   * naming the wrong trophy is worse than naming none — the collector approves
   * a replacement they were never shown.
   */
  it("resolves the replacing trophy through occupantOfSlot, not by index", async () => {
    const { readFileSync } = await import("node:fs")
    // Strip comments first — this file's own prose describes the index form
    // it forbids, so a raw grep matches the warning rather than the code.
    const src = stripComments(readFileSync("app/dashboard/DashboardClient.tsx", "utf8"))
    expect(src).toContain("occupantOfSlot(slabs, pinSlot)")
    expect(src).not.toMatch(/slabs\[\s*pinSlot\s*-\s*1\s*\]/)
  })

  it("syncs a saved caption by the slab's own slot, not by index", async () => {
    const { readFileSync } = await import("node:fs")
    const src = stripComments(readFileSync("app/dashboard/DashboardClient.tsx", "utf8"))
    expect(src).toMatch(/s\.slot === slot/)
  })

  it("guards the guard: occupantOfSlot really does read the slot", async () => {
    // Without this the two assertions above are satisfied by an
    // `occupantOfSlot` that had been rewritten to index — the name would still
    // be present while the property was gone.
    const { occupantOfSlot } = await import("@/lib/trophy/reorder")
    // ⚠ `occupantOfSlot`'s parameter is narrowed to `{ slot: number }`, so the
    // return type carries no `player_name` — cast the RESULT rather than the
    // argument, or `tsc` reds while vitest stays green.
    const packed = [
      { id: 3, slot: 3, player_name: "Third" },
      { id: 1, slot: 1, player_name: "First" },
      null, null, null, null,
    ] as unknown as Parameters<typeof occupantOfSlot>[0]
    const named = (n: number) => occupantOfSlot(packed, n) as { player_name?: string } | null
    expect(named(3)?.player_name).toBe("Third")
    expect(named(1)?.player_name).toBe("First")
    expect(occupantOfSlot(packed, 2)).toBeNull()
  })
})

// 2026-09-02 (onboarding QA #2): an address-path signup has a wallet but no
// public handle, so the "Your public profile" card never rendered and nothing
// pointed at /profile/edit. The claim card fills that hole — but only once the
// bio read has ANSWERED; a failed read shows neither card.
describe("DashboardClient — claim-your-handle card", () => {
  it("renders the claim card when a wallet exists but the bio has no username", async () => {
    routes["/api/profile/bio"] = () => json(200, { bio: { display_name: "Collector", username: null } })
    render(<DashboardClient />)
    expect(await screen.findByText(/claim your handle to get a shareable url/i)).toBeTruthy()
    const link = screen.getByRole("link", { name: /claim handle/i })
    expect(link.getAttribute("href")).toBe("/profile/edit")
    expect(screen.queryByText(/rippackscity\.com\/profile\/collector/)).toBeNull()
  })

  it("renders the public-profile card instead when a handle exists", async () => {
    render(<DashboardClient />)
    expect(await screen.findByText(/rippackscity\.com\/profile\/collector/)).toBeTruthy()
    expect(screen.queryByText(/claim your handle/i)).toBeNull()
  })

  it("renders NEITHER card when the bio read failed — unknown is not 'no handle'", async () => {
    routes["/api/profile/bio"] = () => json(503, {})
    render(<DashboardClient />)
    await screen.findByText(/trophy case/i)
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByText(/claim your handle/i)).toBeNull()
    expect(screen.queryByText(/rippackscity\.com\/profile\//)).toBeNull()
  })
})

// 2026-09-02: the branded token-hash magic link lands on /api/auth/callback
// and redirects straight here, never touching /auth/confirm — so the dashboard
// is where a changed account has to drop the previous one's device keys.
describe("DashboardClient — device keys follow the signed-in account", () => {
  it("clears the previous account's wallet keys when /api/profile/me answers a different user", async () => {
    // The file-level localStorage stub is a no-op; this case needs a real store.
    const store = new Map<string, string>([
      ["rpc_session_user", "someone-else"],
      ["rpc_owner_key", "0xtheirs"],
      ["rpc_owned_0xtheirs", "[]"],
    ])
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size
        },
      },
    })
    render(<DashboardClient />)
    await waitFor(() => expect(store.get("rpc_session_user")).toBe(ME.user.id))
    expect(store.has("rpc_owner_key")).toBe(false)
    expect(store.has("rpc_owned_0xtheirs")).toBe(false)
  })

  it("exposes a Sniper link the tour can anchor to", async () => {
    render(<DashboardClient />)
    const link = await screen.findByRole("link", { name: /^sniper$/i })
    expect(link.getAttribute("data-tour-anchor")).toBe("sniper-nav-link")
    expect(link.getAttribute("href")).toBe("/nba-top-shot/sniper")
  })
})

// 2026-09-02 (onboarding QA #9): the first visit rendered the add-wallet form
// TWICE — the hero's and the wallets section's, driving different input state.
describe("DashboardClient — one add-wallet form on the first visit", () => {
  it("renders the hero form only, with the section's copy behind a link", async () => {
    routes["/api/profile/saved-wallets"] = () => json(200, { wallets: [] })
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    await screen.findByRole("button", { name: /add one here/i })
    expect(screen.queryByPlaceholderText("Dapper username")).toBeNull()
    expect(screen.getAllByRole("button", { name: /load my collection/i })).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: /add one here/i }))
    expect(await screen.findByPlaceholderText("Dapper username")).toBeTruthy()
  })

  it("does NOT point at a hero form that is not there — a failed wallets read shows the section form", async () => {
    routes["/api/profile/saved-wallets"] = () => json(503, {})
    routes["/api/profile/trophy-slabs"] = () => json(200, { slabs: [] })
    render(<DashboardClient />)
    expect(await screen.findByPlaceholderText("Dapper username")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /add one here/i })).toBeNull()
  })
})
