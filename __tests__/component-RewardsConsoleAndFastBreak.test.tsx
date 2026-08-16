// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import AdminRewardsClient from "@/app/admin/rewards/AdminRewardsClient"
import FastBreakClient from "@/app/nba/fast-break/FastBreakClient"

// Two more client pages converted for coverage; both carried a fabricated ZERO.
//
// ⚠ `AdminRewardsClient` already had the good half — an explicit `loadFailed` guarding every
// LIST, added after a failed read rendered "Nothing waiting to ship." over a queue of
// physical redemptions people had already spent credits on. The eight-tile ECONOMY BAND
// above those lists was never covered by it: `num()` coerces an absent value to 0, so a
// failed read published "Outstanding liability 0" and "Pending redemptions 0" in the same
// band that carries the real figures. Fixing the lists and leaving the band is the same
// per-panel scope failure this repo has recorded before — a page is not made honest by
// fixing the component that failed.
//
// ⚠ `FastBreakClient` published "0.00 FP" as the Total Projected from `?? 0`, in 44px brand
// red, DIRECTLY ABOVE its own "Couldn't load the optimizer" line. The page said both at
// once and the number is the louder of the two; read as a claim about the slate rather than
// about us.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))

const TOKEN_KEY = "rpc_admin_token"

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe("AdminRewardsClient", () => {
  const ECONOMY = {
    participants: 20, total_issued_credits: 10000, total_spent_credits: 2500,
    outstanding_liability_credits: 7500, total_status_awarded: 40,
    redemptions_pending: 3, redemptions_fulfilled: 11, ledger_rows: 512,
  }
  const PENDING = (over: Record<string, unknown> = {}) => ({
    id: 1, user_id: "user-abcdef123", username: "collector", item_name: "RPC Hoodie",
    item_type: "merch", cost_credits: 500, requested_at: new Date().toISOString(),
    ts_username: null, ship_to: null, ...over,
  })
  const FULL = {
    economy: ECONOMY,
    balances: [{ user_id: "u1", username: "collector", status: 3, spendable: 900, lifetime_earned: 1200, lifetime_spent: 300 }],
    pending: [PENDING()],
    raffles: [],
    draws: [],
  }

  function mount(opts: { get?: () => Response; post?: () => Response } = {}) {
    localStorage.setItem(TOKEN_KEY, "t")
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (String(input).includes("/api/admin/rewards")) {
        if (method === "POST") return (opts.post ?? (() => json(200, { ok: true })))()
        return (opts.get ?? (() => json(200, FULL)))()
      }
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AdminRewardsClient />)
    return f
  }

  /** The value inside the KPI tile carrying `label`, so an assertion reads the FIGURE. */
  function kpi(label: string): string | null {
    const el = Array.from(document.querySelectorAll("div")).find(
      (d) => d.children.length === 2 && (d.children[0].textContent ?? "").trim() === label,
    )
    return el ? (el.children[1].textContent ?? "").trim() : null
  }

  it("shows the sign-in gate with no token, and does not call the API", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, FULL))
    vi.stubGlobal("fetch", f)
    render(<AdminRewardsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    expect(f).not.toHaveBeenCalled()
  })

  it("renders the economy band and the pending queue", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    expect(kpi("Outstanding liability")).toBe("7,500")
    expect(kpi("Pending redemptions")).toBe("3")
  })

  // ⚠ THE DEFECT. Asserted per TILE, because a page-level search for "0" matches any figure
  // on the board — the vacuous shape mutation caught on the admin-analytics conversion.
  it.each([
    ["a non-2xx", () => json(500, { error: "boom" }, false)],
    ["a payload with no economy block", () => json(200, { ...FULL, economy: null })],
  ])("does not publish a zero liability after %s", async (_l, r) => {
    mount({ get: r as () => Response })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load the economy figures/))
    expect(kpi("Outstanding liability")).toBeNull()
    expect(kpi("Pending redemptions")).toBeNull()
  })

  it("does not publish a zero liability after a thrown fetch", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<AdminRewardsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load the economy figures/))
    expect(kpi("Outstanding liability")).toBeNull()
  })

  // ⚠ THE MIRROR. A programme that genuinely owes nothing must still read 0 — withholding
  // a true zero hides a working metric behind the same treatment as a missing one.
  it("still publishes a genuine zero liability", async () => {
    mount({ get: () => json(200, { ...FULL, economy: { ...ECONOMY, outstanding_liability_credits: 0, redemptions_pending: 0 } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    expect(kpi("Outstanding liability")).toBe("0")
    expect(kpi("Pending redemptions")).toBe("0")
  })

  // Pre-existing and pinned: this is a queue of PHYSICAL goods already paid for, so
  // "Nothing waiting to ship." out of an outage stops an operator fulfilling real orders.
  it("does not say the ship queue is clear after a failed read", async () => {
    mount({ get: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/says nothing about whether any are/i))
    expect(document.body.textContent).not.toMatch(/Nothing waiting to ship/)
  })

  it("does say the ship queue is clear when the read succeeded with none", async () => {
    mount({ get: () => json(200, { ...FULL, pending: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Nothing waiting to ship/))
  })

  it("distinguishes 'could not load balances' from 'no participants yet'", async () => {
    mount({ get: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load balances/))
    expect(document.body.textContent).not.toMatch(/No participants yet/)
    cleanup()
    mount({ get: () => json(200, { ...FULL, balances: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No participants yet/))
  })

  it("signs the operator out on a 401 rather than showing an empty console", async () => {
    mount({ get: () => json(401, {}, false) })
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
  })

  // ⚠ A merch redemption with no address must SAY so. Marking it fulfilled without one
  // sends nothing to nobody and burns the credits.
  it("flags a merch redemption with no shipping address", async () => {
    mount({ get: () => json(200, { ...FULL, pending: [PENDING({ ship_to: null })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No shipping address yet/))
  })

  it("renders a resolved shipping address instead of the warning", async () => {
    mount({ get: () => json(200, { ...FULL, pending: [PENDING({ ship_to: { name: "Trevor", line1: "1 Main St", city: "Portland", region: "OR", postal: "97201", country: "US" } })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Ship to Trevor, 1 Main St/))
    expect(document.body.textContent).not.toMatch(/No shipping address yet/)
  })

  it("flags a moment redemption whose gift target is unresolved", async () => {
    mount({ get: () => json(200, { ...FULL, pending: [PENDING({ item_type: "moment", ts_username: null })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Gift target unresolved/))
    cleanup()
    mount({ get: () => json(200, { ...FULL, pending: [PENDING({ item_type: "moment", ts_username: "collector" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Gift to @collector/))
  })

  it("fulfills a redemption and reloads", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "tx-123"))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^fulfill$/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Done\./))
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ action: "fulfill", redemptionId: 1, note: "tx-123" })
  })

  // ⚠ A refund moves real credits and is confirmed. Declining must send nothing — a
  // "cancel" that still fires the mutation is the worst kind of confirmation dialog.
  it("does not refund when the operator declines the confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^refund$/i.test(b.textContent ?? ""))!)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("refunds when the operator confirms", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^refund$/i.test(b.textContent ?? ""))!)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    )
  })

  it("states a failed action rather than reporting it done", async () => {
    vi.stubGlobal("prompt", vi.fn(() => ""))
    mount({ post: () => json(200, { ok: false, error: "already fulfilled" }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^fulfill$/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/already fulfilled/))
    expect(document.body.textContent).not.toMatch(/Done\./)
  })

  // ⚠ A credit adjustment is a manual mint. Requiring a reason is what makes the ledger
  // auditable afterwards, so a blank one must not reach the API at all.
  it("refuses a manual adjustment with no user or no reason", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /apply adjustment/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/User id and reason are required/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("sends a complete manual adjustment and clears the form", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[]
    // user / delta / status / reason, in the order the form declares them.
    fireEvent.change(inputs[0], { target: { value: "user-1" } })
    fireEvent.change(inputs[1], { target: { value: "-250" } })
    fireEvent.change(inputs[3], { target: { value: "chargeback" } })
    fireEvent.click(screen.getAllByRole("button").find((b) => /apply adjustment/i.test(b.textContent ?? ""))!)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    )
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({
      action: "adjust", userId: "user-1", delta: -250, reason: "chargeback",
    })
  })

  // ── Raffles ────────────────────────────────────────────────────────────────
  // ⚠ A DRAW IS FINAL AND RECORDED — the console's own confirm copy says so. Without a
  // raffle in the fixture the confirm branch was UNREACHABLE and the mutation dropping it
  // survived; the fixture gap, not the assertion, was the problem.
  const RAFFLE = (over: Record<string, unknown> = {}) => ({
    id: 9, sku: "raffle-hoodie", name: "Signed Blazers Jersey", active: true, entry_count: 42, ...over,
  })

  it("does not draw a raffle when the operator declines the confirmation", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false))
    const f = mount({ get: () => json(200, { ...FULL, raffles: [RAFFLE()] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Signed Blazers Jersey/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /draw winner/i.test(b.textContent ?? ""))!)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("draws a raffle when confirmed and names the winner", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    const f = mount({
      get: () => json(200, { ...FULL, raffles: [RAFFLE()] }),
      post: () => json(200, { ok: true, result: { winner_user_id: "user-winner-1" } }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Signed Blazers Jersey/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /draw winner/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Winner drawn: user-winner-1/))
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ action: "draw_raffle", shopItemId: 9 })
  })

  // ⚠ A raffle with no entrants cannot be drawn — a draw over an empty pool would record a
  // result with no winner and cannot be undone.
  it("disables the draw for a raffle with zero entries", async () => {
    mount({ get: () => json(200, { ...FULL, raffles: [RAFFLE({ entry_count: 0 })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Signed Blazers Jersey/))
    const btn = screen.getAllByRole("button").find((b) => /draw winner/i.test(b.textContent ?? ""))!
    expect(btn.hasAttribute("disabled")).toBe(true)
  })

  it("marks an inactive raffle and pluralises a single entry", async () => {
    mount({ get: () => json(200, { ...FULL, raffles: [RAFFLE({ active: false, entry_count: 1 })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/inactive/))
    expect(document.body.textContent).toMatch(/1 entry/)
    expect(document.body.textContent).not.toMatch(/1 entries/)
  })

  it("states a failed draw rather than reporting a winner", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    mount({
      get: () => json(200, { ...FULL, raffles: [RAFFLE()] }),
      post: () => json(200, { ok: false, error: "raffle already drawn" }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Signed Blazers Jersey/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /draw winner/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/raffle already drawn/))
    expect(document.body.textContent).not.toMatch(/Winner drawn/)
  })

  it("lists recent draws", async () => {
    mount({ get: () => json(200, { ...FULL, raffles: [RAFFLE()], draws: [{ id: 1, shop_item_id: 9, winner_user_id: "user-abcdef99", total_entrants: 42, total_credits: 4200, drawn_at: new Date().toISOString() }] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Recent draws/))
    expect(document.body.textContent).toMatch(/winner user-abc/)
    expect(document.body.textContent).toMatch(/42 entrants/)
  })

  it("refresh re-requests and sign out returns to the gate", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/RPC Hoodie/))
    const before = f.mock.calls.length
    fireEvent.click(screen.getAllByRole("button").find((b) => /^refresh$/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))
    fireEvent.click(screen.getAllByRole("button").find((b) => /sign out/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("FastBreakClient", () => {
  // ⚠ Fields taken from `LineupPlayer` in the component, not invented. A wrong key here
  // throws inside <Initials> (`name.split` on undefined) and the whole tree renders EMPTY,
  // which reads as a broken selector rather than a bad fixture.
  const PLAYER = (over: Record<string, unknown> = {}) => ({
    nba_player_id: "1", full_name: "Damian Lillard", team_abbr: "POR", position: "G",
    proj_fp_dk: 42.5, projected_with_captain: null, is_captain: false,
    headshot_url: null, opponent_abbr: "LAL", tipoff_at: null,
    injury_status: null, confidence: null, rank: 1, ...over,
  })
  const RESP = (over: Record<string, unknown> = {}) => ({
    lineup: [PLAYER(), PLAYER({ nba_player_id: "2", full_name: "Stephen Curry", team_abbr: "GSW", rank: 2 })],
    recommended_score: 81.25,
    meta: { run_name: "Fast Break 12", run_is_active: true, eligible_players_pool_size: 120, no_active_run: false, game_date: "2026-08-16" },
    ...over,
  })

  const mount = (r: () => Response | Promise<Response>) => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => r()))
    render(<FastBreakClient />)
  }

  it("renders the lineup and its total", async () => {
    mount(() => json(200, RESP()))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/81\.25 FP/)
    expect(document.body.textContent).toMatch(/Stephen Curry/)
  })

  // ⚠ THE DEFECT. The score band renders ABOVE the error/loading/empty ladder, so on a
  // failed read the page showed "0.00 FP" and "Couldn't load the optimizer" together.
  it.each([
    ["a non-2xx with an error body", () => json(503, { error: "optimizer unavailable" }, false)],
    ["a non-2xx with no error body", () => json(500, {}, false)],
  ])("withholds the projected total after %s", async (_l, r) => {
    mount(r as () => Response)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load the optimizer/))
    expect(document.body.textContent).not.toMatch(/0\.00 FP/)
    expect(document.body.textContent).toMatch(/—/)
  })

  it("withholds the projected total after a thrown fetch", async () => {
    mount(() => { throw new Error("network down") })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load the optimizer/))
    expect(document.body.textContent).not.toMatch(/0\.00 FP/)
  })

  // ⚠ THE MIRROR. A slate that genuinely projects nothing must still read 0.00 — a real
  // measurement must not be hidden behind the same em-dash as a failure.
  it("still renders a genuine zero total", async () => {
    mount(() => json(200, RESP({ recommended_score: 0, lineup: [PLAYER()] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/0\.00 FP/)
  })

  // The error branch must beat both empty states: "No Fast Break run is currently active"
  // and "No NBA games on <date>" are claims about the NBA, not about us.
  it("does not claim there is no active run, or no games, when the read failed", async () => {
    mount(() => json(500, {}, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn’t load the optimizer/))
    expect(document.body.textContent).not.toMatch(/No Fast Break run is currently active/)
    expect(document.body.textContent).not.toMatch(/No NBA games on/)
  })

  it("says there is no active run when the API says so", async () => {
    mount(() => json(200, RESP({ lineup: [], meta: { no_active_run: true, game_date: "2026-08-16" } })))
    await waitFor(() => expect(document.body.textContent).toMatch(/No Fast Break run is currently active/))
  })

  it("says there are no games when the slate is genuinely empty", async () => {
    mount(() => json(200, RESP({ lineup: [], meta: { no_active_run: false, run_name: "Fast Break 12", run_is_active: false, game_date: "2026-08-16" } })))
    await waitFor(() => expect(document.body.textContent).toMatch(/No NBA games on/))
    expect(document.body.textContent).not.toMatch(/No Fast Break run is currently active/)
  })

  it("re-requests for the date the visitor picks", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, RESP()))
    vi.stubGlobal("fetch", f)
    render(<FastBreakClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const before = f.mock.calls.length
    const pills = screen.getAllByRole("button").filter((b) => /\d/.test(b.textContent ?? ""))
    if (pills.length > 1) {
      fireEvent.click(pills[pills.length - 1])
      await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))
      expect(String(f.mock.calls[f.mock.calls.length - 1][0])).toMatch(/game_date=\d{4}-\d{2}-\d{2}/)
    }
  })

  it("renders an injury status when the API reports one", async () => {
    mount(() => json(200, RESP({ lineup: [PLAYER({ injury_status: "QUESTIONABLE" })] })))
    await waitFor(() => expect(document.body.textContent).toMatch(/QUESTIONABLE/i))
  })
})
