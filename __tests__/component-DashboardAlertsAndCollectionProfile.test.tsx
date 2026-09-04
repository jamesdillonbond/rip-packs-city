// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import DashboardAlertsClient from "@/app/dashboard/alerts/DashboardAlertsClient"
import CollectionProfileClient from "@/app/(collections)/[collection]/profile/[username]/CollectionProfileClient"

// Two more client pages converted for coverage. Both were already hardened — recorded so
// nobody re-sweeps them — and both carry a claim about the READER'S OWN ACCOUNT, which is
// the worst version of the failed-read class: the reader is the one person who knows it is
// wrong, and it is actionable, so it makes them do something.
//
// `dashboard/alerts`: the loader sets `alerts` to `[]` on a failure, so the "No alerts yet
// — create your first alert" welcome card is gated on `!err`. Without that gate a collector
// with a dozen live alerts hits a 503 and is invited to create a DUPLICATE, with the error
// banner rendering directly above — the page contradicting itself on screen.
//
// `[collection]/profile/[username]`: failure is tracked PER LEG, not by one flag, because a
// sniper-feed hiccup must not blank the trophy case.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard/alerts",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("@/lib/owner-key", () => ({
  getOwnerKey: () => "0xowner",
  onOwnerKeyChange: () => () => {},
}))
vi.mock("@/lib/hooks/useProStatus", () => ({
  useProStatus: () => ({ isPro: true, loading: false, tier: "pro" }),
}))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

beforeEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe("DashboardAlertsClient", () => {
  // ⚠ Every field taken from the component's own `Alert` interface. An invented shape here
  // renders nothing and the failure reads as a broken selector rather than a bad fixture.
  const ALERT = (over: Record<string, unknown> = {}) => ({
    id: 1, owner_key: "0xowner", edition_key: "48:1652",
    player_name: "Damian Lillard", set_name: "Archive Set",
    alert_type: "below_price" as const, threshold: 5, channel: "email" as const,
    notification_email: "t@example.test", active: true, last_triggered_at: null,
    created_at: new Date().toISOString(),
    fmv: 20, low_ask: 8, current_discount_pct: 60, currently_triggered: false, ...over,
  })

  function mount(opts: { list?: () => Response; write?: () => Response } = {}) {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (String(input).includes("/api/alerts")) {
        if (method !== "GET") return (opts.write ?? (() => json(200, { ok: true })))()
        return (opts.list ?? (() => json(200, [ALERT()])))()
      }
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<DashboardAlertsClient />)
    return f
  }

  it("lists the alerts it loaded", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/No alerts yet/)
  })

  // ⚠ THE CLAIM ABOUT THE READER'S OWN ACCOUNT. `alerts` is set to `[]` on every failure
  // path, so `!err` is the ONLY thing between a 503 and a collector being told they have no
  // alerts and invited to make a duplicate of one they already have.
  it.each([
    ["a non-2xx", () => json(503, { error: "the database is under heavy load" }, false)],
    ["a 500 with no error body", () => json(500, {}, false)],
  ])("does not offer to create a first alert after %s", async (_l, r) => {
    mount({ list: r as () => Response })
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading…/))
    expect(document.body.textContent).not.toMatch(/No alerts yet/)
    expect(document.body.textContent).not.toMatch(/Create your first alert/)
  })

  it("does not offer to create a first alert after a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<DashboardAlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/network down/))
    expect(document.body.textContent).not.toMatch(/No alerts yet/)
  })

  // ⚠ THE MIRROR. A genuinely empty account must still get the welcome card — that is the
  // whole onboarding path, and blanking it would trade one false claim for a dead end.
  it("does offer to create a first alert when the read succeeded with none", async () => {
    mount({ list: () => json(200, []) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
    expect(document.body.textContent).toMatch(/Create your first alert/)
  })

  // A body that is not an array is a malformed response, not a list of alerts. Rendering it
  // would throw on `.map`; treating it as empty is the honest degradation.
  it("survives a 200 whose body is not an array", async () => {
    mount({ list: () => json(200, { unexpected: true }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
  })

  it("toggles an alert active and reloads", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const toggle = screen.getAllByRole("button").find((b) => /pause|resume|active|enable|disable/i.test(b.textContent ?? ""))
    if (toggle) {
      fireEvent.click(toggle)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true),
      )
    }
  })

  it("states a failed toggle rather than silently doing nothing", async () => {
    mount({ write: () => json(500, { error: "could not update alert" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const toggle = screen.getAllByRole("button").find((b) => /pause|resume|active|enable|disable/i.test(b.textContent ?? ""))
    if (toggle) {
      fireEvent.click(toggle)
      await waitFor(() => expect(document.body.textContent).toMatch(/could not update alert/))
    }
  })

  // ⚠ DELETE IS TWO-STEP AND THAT IS THE SAFETY. The first click ARMS; only a second click
  // inside the window commits. One click sending the DELETE would destroy an alert with no
  // undo — this replaced a browser confirm() precisely so the affordance is visible.
  it("does not delete on the first click", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const del = screen.getAllByRole("button").find((b) => /delete|remove/i.test(b.textContent ?? ""))!
    fireEvent.click(del)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false)
  })

  it("deletes on a second click inside the confirm window", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const del = () => screen.getAllByRole("button").find((b) => /delete|remove|confirm|sure/i.test(b.textContent ?? ""))!
    fireEvent.click(del())
    fireEvent.click(del())
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(true),
    )
  })

  // ── Row rendering: the two alert TYPES read completely differently ─────────
  // ⚠ `below_price` and `below_fmv_pct` are the same column showing different units. A
  // discount alert rendered as a dollar figure (or vice versa) is a wrong number wearing a
  // right one's clothes — the collector reads "$20" and thinks it fires at twenty dollars.
  it("describes a price alert in dollars", async () => {
    mount({ list: () => json(200, [ALERT({ alert_type: "below_price", threshold: 1500 })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Lowest ask ≤/))
    // fmtUsd rounds and thousands-separates at >= 1000.
    expect(document.body.textContent).toMatch(/\$1,500/)
  })

  it("describes a discount alert as a percentage", async () => {
    mount({ list: () => json(200, [ALERT({ alert_type: "below_fmv_pct", threshold: 25, current_discount_pct: 12 })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Discount vs FMV ≥ 25%/))
    expect(document.body.textContent).toMatch(/12%/)
  })

  // ⚠ An em-dash, never $0. "Current: $0.00" on a price alert says the moment is listed for
  // nothing, which would look like the deal of the platform.
  it("renders an em-dash for a missing current value", async () => {
    mount({ list: () => json(200, [ALERT({ low_ask: null })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/—/)
    expect(document.body.textContent).not.toMatch(/\$0\.00/)
  })

  it("renders a small current value with cents rather than rounding it away", async () => {
    mount({ list: () => json(200, [ALERT({ low_ask: 4.5 })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/\$4\.50/))
  })

  it.each([
    ["active", { active: true, currently_triggered: false }, /Active/],
    ["paused", { active: false }, /Paused/],
    ["triggered", { active: true, currently_triggered: true }, /Triggered/],
  ])("renders the %s status pill", async (_l, over, expected) => {
    mount({ list: () => json(200, [ALERT(over as Record<string, unknown>)]) })
    await waitFor(() => expect(document.body.textContent).toMatch(expected as RegExp))
  })

  it("shows when an alert last fired", async () => {
    mount({ list: () => json(200, [ALERT({ last_triggered_at: new Date().toISOString() })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Last fired/))
  })

  it("does not claim an alert has fired when it never has", async () => {
    mount({ list: () => json(200, [ALERT({ last_triggered_at: null })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/Last fired/)
  })

  // A row we cannot name falls back to the edition key, never a blank cell.
  it("falls back to the edition key for an unnamed alert", async () => {
    mount({ list: () => json(200, [ALERT({ player_name: null, set_name: null })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/48:1652/))
    expect(document.body.textContent).toMatch(/—/)
  })

  it("states a failed search after a thrown fetch", async () => {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("search-editions")) throw new Error("search network down")
      if (url.includes("/api/alerts") && (init?.method ?? "GET") === "GET") return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<DashboardAlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create your first alert/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(screen.getByPlaceholderText(/Player name, set name/)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/Player name, set name/), { target: { value: "lillard" } })
    fireEvent.click(screen.getAllByRole("button").find((b) => /^search$/i.test((b.textContent ?? "").trim()))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/search network down/))
    expect(document.body.textContent).not.toMatch(/No matches\./)
  })

  it("searches on Enter as well as on the button", async () => {
    const f = mountModal()
    await openModal()
    const input = screen.getByPlaceholderText(/Player name, set name/)
    fireEvent.change(input, { target: { value: "lillard" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("search-editions"))).toBe(true))
  })

  // Until 2026-09-03 the modal had no keyboard path at all: no Escape, no focus
  // trap. It now shares lib/hooks/useModalA11y with every other dialog.
  it("Escape closes the modal without creating anything", async () => {
    const f = mountModal()
    await openModal()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByPlaceholderText(/Player name, set name/)).toBeNull())
    expect(f.mock.calls.some((c) => (c[1]?.method ?? "GET").toUpperCase() === "POST")).toBe(false)
  })

  it("moves focus into the modal on open", async () => {
    mountModal()
    await openModal()
    const dialog = screen.getByRole("dialog")
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })

  // ── The create-alert modal ─────────────────────────────────────────────────
  const EDITION = (over: Record<string, unknown> = {}) => ({
    edition_id: "e1", edition_key: "48:1652", player_name: "Damian Lillard",
    set_name: "Archive Set", collection_slug: "nba-top-shot", fmv: 20, ...over,
  })

  function mountModal(opts: { search?: () => Response; create?: () => Response } = {}) {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? "GET").toUpperCase()
      if (url.includes("search-editions")) return (opts.search ?? (() => json(200, { editions: [EDITION()] })))()
      if (url.includes("/api/alerts")) {
        if (method === "POST") return (opts.create ?? (() => json(200, ALERT())))()
        return json(200, [])
      }
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<DashboardAlertsClient />)
    return f
  }
  const openModal = async () => {
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create your first alert/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(screen.getByPlaceholderText(/Player name, set name/)).toBeTruthy())
  }
  // ⚠ SCOPED TO THE MODAL. The page header also carries a "+ Create Alert" button, so a
  // page-wide /create alert/i query matches two elements and throws — the failure reads as
  // the modal not rendering.
  const submitBtn = () =>
    Array.from(document.querySelectorAll(".rpc-al-modal button")).find(
      (b) => /^create alert$/i.test((b.textContent ?? "").trim()),
    ) as HTMLButtonElement

  const search = async (q = "lillard") => {
    fireEvent.change(screen.getByPlaceholderText(/Player name, set name/), { target: { value: q } })
    fireEvent.click(screen.getAllByRole("button").find((b) => /^search$/i.test((b.textContent ?? "").trim()))!)
  }

  it("searches for an edition and lets one be picked", async () => {
    const f = mountModal()
    await openModal()
    await search()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(f.mock.calls.some((c) => String(c[0]).includes("search-editions"))).toBe(true)
  })

  // ⚠ A blank query must not go to the network — an empty search returns everything or
  // nothing, and either way it is a request nobody asked for.
  it("does not search for a blank query", async () => {
    const f = mountModal()
    await openModal()
    fireEvent.click(screen.getAllByRole("button").find((b) => /^search$/i.test((b.textContent ?? "").trim()))!)
    expect(f.mock.calls.some((c) => String(c[0]).includes("search-editions"))).toBe(false)
  })

  // ⚠ A FAILED SEARCH sets matches to [], so "No matches." is gated on the error — otherwise
  // a 503 tells a collector the moment they are looking for does not exist in our catalogue.
  it("does not say 'no matches' when the search itself failed", async () => {
    mountModal({ search: () => json(503, { error: "search unavailable" }, false) })
    await openModal()
    await search()
    await waitFor(() => expect(document.body.textContent).toMatch(/search unavailable/))
    expect(document.body.textContent).not.toMatch(/No matches\./)
  })

  it("does say 'no matches' when the search succeeded with none", async () => {
    mountModal({ search: () => json(200, { editions: [] }) })
    await openModal()
    await search("zzzz")
    await waitFor(() => expect(document.body.textContent).toMatch(/No matches\./))
  })

  // ⚠ A SECOND search that fails must CLEAR the first one's results. Leaving them on screen
  // shows a collector matches for a query they have already changed, and they pick an
  // edition believing it matched the new one — mutation-confirmed, and it needs a
  // two-search fixture: on a first-search failure `matches` is still null, so both
  // implementations render nothing and the assertion cannot see the difference.
  it("clears stale matches when a later search fails", async () => {
    let n = 0
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("search-editions")) {
        n += 1
        return n === 1 ? json(200, { editions: [EDITION()] }) : json(503, { error: "search unavailable" }, false)
      }
      if (url.includes("/api/alerts") && (init?.method ?? "GET") === "GET") return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<DashboardAlertsClient />)
    await openModal()
    await search("lillard")
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    await search("curry")
    await waitFor(() => expect(document.body.textContent).toMatch(/search unavailable/))
    expect(document.body.textContent).not.toMatch(/Damian Lillard/)
  })

  it("accepts a bare-array search response as well as an { editions } envelope", async () => {
    mountModal({ search: () => json(200, [EDITION({ player_name: "Stephen Curry" })]) })
    await openModal()
    await search("curry")
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
  })

  async function pickAndConfigure(opts: Parameters<typeof mountModal>[0] = {}) {
    const f = mountModal(opts)
    await openModal()
    await search()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /Damian Lillard/.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Threshold/))
    return f
  }

  // ⚠ THE THRESHOLD BOUNDS ARE THE WHOLE POINT OF THE ALERT. A 0 or negative threshold can
  // never fire; a discount ≥100% is not expressible; and a price ≥$1,000,000 is a typo, not
  // an intent. Each is rejected with its OWN message, so the collector is told which bound
  // they crossed rather than "invalid".
  // ⚠ "abc" is deliberately NOT a case. The input is `type="number"`, so a non-numeric value
  // never reaches state — the browser (and jsdom) normalize it to "". The
  // `!Number.isFinite` branch is a defensive backstop for a value arriving some other way,
  // and contriving a fixture for it would assert a state this UI cannot produce.
  it.each([
    ["0", /greater than 0/],
    ["-5", /greater than 0/],
  ])("rejects a threshold of %s inline", async (value, expected) => {
    await pickAndConfigure()
    const input = screen.getByPlaceholderText("10.00")
    fireEvent.change(input, { target: { value } })
    await waitFor(() => expect(document.body.textContent).toMatch(expected as RegExp))
  })

  it("rejects a price threshold at or above $1,000,000", async () => {
    await pickAndConfigure()
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "1000000" } })
    await waitFor(() => expect(document.body.textContent).toMatch(/under \$1,000,000/))
  })

  it("accepts a threshold inside the bounds without complaint", async () => {
    await pickAndConfigure()
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "9.99" } })
    await waitFor(() => expect(document.body.textContent).toMatch(/Threshold/))
    expect(document.body.textContent).not.toMatch(/must be|under \$1,000,000/)
  })

  // ⚠ An email channel with an unusable address produces an alert that fires into nothing —
  // the silent-failure shape this repo has already paid for on `manage_alerts`.
  it("refuses to submit an email alert with an invalid address", async () => {
    const f = await pickAndConfigure()
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "5" } })
    // ⚠ Addressed by placeholder, not by a permissive regex. `type="email"` in jsdom does
    // NOT reject a malformed value, which is exactly why the component validates it itself.
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "not-an-email" } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/valid notification email/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("submits a valid alert", async () => {
    const f = await pickAndConfigure()
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "5" } })
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "t@example.test" } })
    fireEvent.click(submitBtn())
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    )
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({
      edition_key: "48:1652", alert_type: "below_price", threshold: 5, notification_email: "t@example.test",
    })
  })

  // ⚠ A 402 is a PAYWALL, not an error. Rendering it as "HTTP 402" tells a collector
  // something broke when in fact they need to upgrade — a dead end instead of a path.
  it("renders a 402 as the upgrade prompt, not as a failure", async () => {
    await pickAndConfigure({ create: () => json(402, { message: "Custom alerts are a Pro feature." }, false) })
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "5" } })
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "t@example.test" } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Pro feature|Upgrade to Pro/))
    expect(document.body.textContent).not.toMatch(/HTTP 402/)
  })

  it("switches the alert type to a discount percentage", async () => {
    await pickAndConfigure()
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    if (radios.length > 1) {
      fireEvent.click(radios[1])
      await waitFor(() => expect(screen.queryByPlaceholderText("20")).toBeTruthy())
    }
  })

  // ⚠ The channel decides WHERE the alert is delivered, and the email field only exists for
  // the email/both channels. Picking telegram must send `notification_email: null` rather
  // than carrying a stale address — the alert would otherwise mail somebody who asked for
  // Telegram.
  it("sends no notification email when the channel is telegram", async () => {
    const f = await pickAndConfigure()
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "5" } })
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "t@example.test" } })
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    const telegram = radios.find((r) => /telegram/i.test(r.parentElement?.textContent ?? ""))
    if (telegram) {
      fireEvent.click(telegram)
      await waitFor(() => expect(screen.queryByPlaceholderText("you@example.com")).toBeNull())
      fireEvent.click(submitBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
      const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
      expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({
        channel: "telegram", notification_email: null,
      })
    }
  })

  it("switches to the discount alert type and sends it", async () => {
    const f = await pickAndConfigure()
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    const pct = radios.find((r) => /discount|below fmv|%/i.test(r.parentElement?.textContent ?? ""))
    if (pct) {
      fireEvent.click(pct)
      await waitFor(() => expect(screen.queryByPlaceholderText("20")).toBeTruthy())
      fireEvent.change(screen.getByPlaceholderText("20"), { target: { value: "25" } })
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "t@example.test" } })
      fireEvent.click(submitBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
      const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
      expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({
        alert_type: "below_fmv_pct", threshold: 25,
      })
    }
  })

  it("rejects a discount threshold at or above 100", async () => {
    await pickAndConfigure()
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[]
    const pct = radios.find((r) => /discount|below fmv|%/i.test(r.parentElement?.textContent ?? ""))
    if (pct) {
      fireEvent.click(pct)
      await waitFor(() => expect(screen.queryByPlaceholderText("20")).toBeTruthy())
      fireEvent.change(screen.getByPlaceholderText("20"), { target: { value: "100" } })
      await waitFor(() => expect(document.body.textContent).toMatch(/under 100/))
    }
  })

  it("goes back to the search step without losing the modal", async () => {
    mountModal()
    await openModal()
    await search()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /Damian Lillard/.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Threshold/))
    const back = Array.from(document.querySelectorAll(".rpc-al-modal button")).find(
      (b) => /back|change|←/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement | undefined
    if (back) {
      fireEvent.click(back)
      await waitFor(() => expect(screen.getByPlaceholderText(/Player name, set name/)).toBeTruthy())
    }
  })

  it("closes on the ✕ and on Cancel without writing", async () => {
    const f = mountModal()
    await openModal()
    fireEvent.click(Array.from(document.querySelectorAll(".rpc-al-modal button")).find((b) => (b.textContent ?? "").includes("✕")) as HTMLButtonElement)
    await waitFor(() => expect(screen.queryByPlaceholderText(/Player name, set name/)).toBeNull())
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  // ⚠ The paywall notice must CLEAR when the collector opens the form again. A stale
  // "Upgrade to Pro" banner above a working form is a claim they cannot act on.
  it("clears a previous paywall notice when the form is reopened", async () => {
    await pickAndConfigure({ create: () => json(402, { message: "Custom alerts are a Pro feature." }, false) })
    fireEvent.change(screen.getByPlaceholderText("10.00"), { target: { value: "5" } })
    fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "t@example.test" } })
    fireEvent.click(submitBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Pro feature/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create your first alert|\+ Create Alert/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(screen.getByPlaceholderText(/Player name, set name/)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/Pro feature/)
  })

  it("closes on the backdrop", async () => {
    mountModal()
    await openModal()
    const backdrop = document.querySelector(".rpc-al-modal-backdrop")!
    fireEvent.click(backdrop)
    await waitFor(() => expect(screen.queryByPlaceholderText(/Player name, set name/)).toBeNull())
  })

  it("opens the create form", async () => {
    mount({ list: () => json(200, []) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /create your first alert/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.querySelectorAll("input").length).toBeGreaterThan(0))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CollectionProfileClient", () => {
  const TROPHY = (over: Record<string, unknown> = {}) => ({
    slot: 1, edition_key: "48:1652", player_name: "Damian Lillard",
    set_name: "Archive Set", serial_number: 12, thumbnail_url: null,
    fmv_usd: 900, tier: "LEGENDARY", note: null, ...over,
  })

  function mount(opts: {
    trophies?: () => Response
    sniper?: () => Response
    bio?: () => Response
    wallets?: () => Response
    snapshots?: () => Response
  } = {}) {
    const f = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("trophy")) return (opts.trophies ?? (() => json(200, { trophies: [TROPHY()] })))()
      if (url.includes("sniper")) return (opts.sniper ?? (() => json(200, { deals: [] })))()
      if (url.includes("bio")) return (opts.bio ?? (() => json(200, { bio: { display_name: "Trevor", tagline: "Blazers" } })))()
      if (url.includes("wallet")) return (opts.wallets ?? (() => json(200, { wallets: [] })))()
      if (url.includes("snapshot") || url.includes("portfolio")) return (opts.snapshots ?? (() => json(200, { snapshots: [] })))()
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<CollectionProfileClient collection="nba-top-shot" username="trevor" />)
    return f
  }

  it("renders the profile for the username it was given", async () => {
    const f = mount()
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(0))
    // ⚠ The username arrives as a PROP now, not from useParams. If the prop were dropped
    // every request would go out for `undefined` and the page would render a stranger's
    // (empty) profile without saying anything was wrong.
    expect(f.mock.calls.some((c) => String(c[0]).includes("trevor"))).toBe(true)
  })

  // ⚠ PER-LEG, NOT ONE FLAG. A sniper-feed hiccup must not blank the trophy case: they are
  // independent reads about different things, and collapsing them means one failure erases
  // a panel that loaded perfectly well.
  it("keeps the trophy case when only the sniper leg fails", async () => {
    mount({ sniper: () => json(500, { error: "sniper unavailable" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
  })

  // ⚠ MUTATION SURVIVOR, DOCUMENTED RATHER THAN CONTRIVED AWAY — category "redundant behind
  // another guard". Deleting either explicit `if (!data) setFailed(...)` line changes NOTHING
  // observable: `r.ok ? r.json() : null` hands the next `.then` a null, `data.trophies` /
  // `data.deals.slice` throws, and the `.catch` sets the very same flag. No fixture can
  // separate them, so the assertions below pin the COMPOSITE — removing the guard AND its
  // catch backstop together does redden, and that is verified.
  //   The explicit guards are still worth keeping: they are the only version that survives
  // someone later making the failure path non-throwing (e.g. `?? {}`), which is exactly the
  // change that would silently reopen the defect.

  // ⚠ ASSERTED ON THE PAGE'S OWN COPY, not on guessed wording. My first version searched for
  // /hasn't pinned|no trophies yet/ — a phrase this page never emits — so BOTH mutations
  // survived: the assertion was vacuous in exactly the way it was written to prevent.
  // Grep the component for the sentence before asserting its absence.
  it("does not claim an empty trophy case when the trophy leg failed", async () => {
    mount({ trophies: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load this trophy case/))
    expect(document.body.textContent).toMatch(/says nothing about what they've pinned/)
    // ⚠ The headline counter must drop the "N / 3 TROPHY MOMENTS" suffix too — three empty
    // slabs plus "0 / 3" is a claim about what this collector curated, on their public page.
    expect(document.body.textContent).not.toMatch(/0 \/ 3 TROPHY MOMENTS/)
  })

  it("does show the trophy count when the read succeeded", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/1 \/ 3 TROPHY MOMENTS/)
  })

  // ⚠ "No live deals available right now." is a claim about the MARKET. Ordering is what
  // makes the guard non-inert: an emptiness check first would swallow the failure, because a
  // failed read leaves the list empty.
  it("does not claim there are no live deals when the sniper leg failed", async () => {
    mount({ sniper: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load live deals/))
    expect(document.body.textContent).not.toMatch(/No live deals available right now/)
  })

  it("does claim there are no live deals when the feed genuinely returned none", async () => {
    mount({ sniper: () => json(200, { deals: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No live deals available right now/))
    expect(document.body.textContent).not.toMatch(/Couldn't load live deals/)
  })

  it("survives a thrown fetch on every leg without rendering a false claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<CollectionProfileClient collection="nba-top-shot" username="trevor" />)
    await waitFor(() => expect(document.body.textContent ?? "").not.toMatch(/^$/))
    expect(document.body.textContent).not.toMatch(/hasn.t pinned|no trophies yet/i)
  })

  // ⚠ NEGATIVE RESULT, recorded rather than asserted the other way: the per-collection
  // profile slab does NOT render `note` — that is the shareable /profile/<u>/trophy-case
  // surface. Asserting the note here would have failed against correct code.
  it("renders a filled trophy slab with its serial and set", async () => {
    mount({ trophies: () => json(200, { trophies: [TROPHY({ note: "my first grail" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/Archive Set/)
    expect(document.body.textContent).not.toMatch(/my first grail/)
  })

  // ⚠ The sniper panel reads a camelCase DTO (`playerName` / `askPrice` / `adjustedFmv` /
  // `discount`), not the snake_case board row every other panel uses. Getting it wrong
  // throws on `deal.discount.toFixed` and the WHOLE PAGE renders empty — which looks like a
  // routing problem, not a fixture one.
  // ── Trophy slab rendering ──────────────────────────────────────────────────
  // The tier drives BOTH the border colour and the holo class. A slab that silently falls
  // through to COMMON for a real tier misrepresents the rarity of a collector's grail on
  // the page they share.
  it.each([
    ["LEGENDARY"], ["ULTIMATE"], ["RARE"], ["UNCOMMON"], ["FANDOM"], ["COMMON"], [null],
  ])("renders a %s trophy slab", async (tier) => {
    mount({ trophies: () => json(200, { trophies: [TROPHY({ tier })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
  })

  // ⚠ A missing thumbnail must resolve to the inline placeholder, never `src={null}` — an
  // empty src makes the browser re-request the PAGE as an image.
  it("renders a placeholder for a trophy with no thumbnail", async () => {
    mount({ trophies: () => json(200, { trophies: [TROPHY({ thumbnail_url: null })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const imgs = Array.from(document.querySelectorAll("img")) as HTMLImageElement[]
    expect(imgs.some((i) => i.getAttribute("src")?.startsWith("data:image/svg+xml"))).toBe(true)
    expect(imgs.every((i) => (i.getAttribute("src") ?? "") !== "")).toBe(true)
  })

  it("plays the video on hover and falls back to the still on a video error", async () => {
    mount({ trophies: () => json(200, { trophies: [TROPHY({ video_url: "https://example.test/clip.mp4" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const slab = document.querySelector(".rpc-holo-legendary") ?? document.querySelector("[style*='aspect-ratio']")!
    fireEvent.mouseEnter(slab)
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy())
    fireEvent.error(document.querySelector("video")!)
    // ⚠ A broken clip must degrade to the still image, not to an empty tile — the slab is
    // the whole point of the page.
    await waitFor(() => expect(document.querySelectorAll("img").length).toBeGreaterThan(0))
    fireEvent.mouseLeave(slab)
  })

  it("dims a trophy image that fails to load rather than leaving a broken icon", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const img = Array.from(document.querySelectorAll("img")).find((i) => (i as HTMLImageElement).alt === "Damian Lillard") as HTMLImageElement | undefined
    if (img) {
      fireEvent.error(img)
      expect(img.style.opacity).toBe("0.3")
    }
  })

  it("renders empty slots for the trophies the collector has not pinned", async () => {
    mount({ trophies: () => json(200, { trophies: [TROPHY()] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/EMPTY SLOT/))
  })

  // Slots are keyed by their `slot` column, so an out-of-range value must be IGNORED rather
  // than written past the end of the three-slot array.
  it("ignores a trophy whose slot is out of range", async () => {
    mount({ trophies: () => json(200, { trophies: [TROPHY({ slot: 9, player_name: "Ghost" })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/EMPTY SLOT/))
    expect(document.body.textContent).not.toMatch(/Ghost/)
  })

  it("falls back to the monogram when the avatar image fails to load", async () => {
    mount({ bio: () => json(200, { bio: { display_name: "Trevor", avatar_url: "https://example.test/a.png" } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Trevor/))
    const avatar = Array.from(document.querySelectorAll("img")).find((i) => (i as HTMLImageElement).alt === "trevor") as HTMLImageElement | undefined
    if (avatar) {
      fireEvent.error(avatar)
      await waitFor(() => expect(document.body.textContent).toMatch(/T/))
    }
  })

  // ⚠ The avatar prompt writes the collector's own profile, so a cancelled prompt (or a
  // blank one) must send NOTHING — a POST with an empty url would clear the avatar they
  // already had.
  it("does not write the avatar when the prompt is cancelled or blank", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    vi.stubGlobal("prompt", vi.fn(() => null))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/EDIT BIO/))
    const avatar = document.querySelector("[style*='border-radius: 50%']") ?? document.querySelector("img")
    if (avatar) fireEvent.click(avatar)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  // ── Portfolio stats and the owner surface ─────────────────────────────────
  const WALLET = (over: Record<string, unknown> = {}) => ({
    wallet_addr: "0xmine", cached_fmv: 1200, cached_moment_count: 34,
    verified_at: new Date().toISOString(), ...over,
  })

  // ⚠ THE `> 0` GATE IS WHAT MAKES A FAILED WALLETS READ SAFE. Every portfolio stat renders
  // an em-dash rather than a manufactured $0, which is why `wallets` needs no failure flag
  // of its own — the honesty lives in the render, not in a state variable.
  it("renders an em-dash rather than $0 when no wallet data loaded", async () => {
    mount({ wallets: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/\$0\b/)
    expect(document.body.textContent).toMatch(/—/)
  })

  it("renders the portfolio totals when wallets loaded", async () => {
    mount({ wallets: () => json(200, { wallets: [WALLET(), WALLET({ wallet_addr: "0xsecond", cached_fmv: 300, cached_moment_count: 6 })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    // ⚠ Summed across wallets, then formatted: `fmtDollars` abbreviates at 1000, so 1500
    // renders "$1.5K", not "1,500". Asserting the raw sum would have failed against correct
    // code — read the formatter, not the payload.
    expect(document.body.textContent).toContain("$1.5K")
    // ⚠ Read from the MOMENTS tile, not the page: "40" also appears inside "$300.00" and
    // inside the wallet list, so a page-wide match would pass with the tile blank.
    expect(document.body.textContent).toContain("MOMENTS40")
  })

  it("renders a bio when one loaded", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Trevor/))
    expect(document.body.textContent).toMatch(/Blazers/)
  })

  // The owner surface is keyed on a localStorage owner key matching the profile's username.
  // A visitor must not be shown the editor; the owner must be.
  it("hides the owner controls from a visitor", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/EDIT BIO/)
  })

  it("shows the owner controls to the owner", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/EDIT BIO/))
  })

  it("opens the bio editor and saves", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    const f = mount({ bio: () => json(200, { bio: { display_name: "Trevor", tagline: "Blazers" } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/EDIT BIO/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /edit bio/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/CANCEL/))
    const save = screen.getAllByRole("button").find((b) => /save/i.test(b.textContent ?? ""))
    if (save) {
      fireEvent.click(save)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
    }
  })

  it("closes the bio editor on cancel without writing", async () => {
    localStorage.setItem("rpc_owner_key", "trevor")
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/EDIT BIO/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /edit bio/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/CANCEL/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^cancel$/i.test((b.textContent ?? "").trim()))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/EDIT BIO/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  // ── The per-wallet FMV chart (reached via "LOAD →") ────────────────────────
  const HISTORY = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      snapshot_date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
      total_fmv: 1000 + i * 25,
      moment_count: 30 + i,
    }))

  async function loadChart(history: () => Response) {
    const f = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("trophy")) return json(200, { trophies: [TROPHY()] })
      if (url.includes("sniper")) return json(200, { deals: [] })
      if (url.includes("bio")) return json(200, { bio: { display_name: "Trevor" } })
      // ⚠ ORDER MATTERS: the per-wallet chart calls portfolio-history with `?wallet=`, and
      // the page-level call uses `?ownerKey=`. Checking "wallet" before "portfolio" would
      // route the chart's request to the saved-wallets stub and the chart would never load.
      if (url.includes("portfolio-history")) return history()
      if (url.includes("wallet")) return json(200, { wallets: [WALLET()] })
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<CollectionProfileClient collection="nba-top-shot" username="trevor" />)
    // ⚠ No click needed: `PortfolioValueCard` mounts automatically for `wallets[0]`. The
    // "LOAD →" affordance beside each wallet is a Link to the collection page, not the
    // chart trigger — assuming otherwise cost a round of "Unable to find role button".
    await waitFor(() => expect(document.body.textContent).toMatch(/PORTFOLIO VALUE/))
    return f
  }

  it("charts a wallet's FMV history", async () => {
    await loadChart(() => json(200, { snapshots: HISTORY(10) }))
    await waitFor(() => expect(document.body.textContent).toMatch(/PORTFOLIO VALUE/))
    // The latest point, formatted: 1000 + 9*25 = 1225 -> "$1.2K".
    await waitFor(() => expect(document.body.textContent).toContain("$1.2K"))
  })

  // ⚠ THE THREE STATES AGAIN, on a per-wallet series. "No FMV history yet for this wallet."
  // is a claim about THAT WALLET; a failed read must not make it.
  // ⚠ MUTATION SURVIVOR, DOCUMENTED — same "redundant behind another guard" category as the
  // page-level trophy/sniper legs. Deleting `if (!data) setLoadFailed(true)` changes nothing
  // observable: `r.ok ? r.json() : null` hands the next `.then` a null, `data.snapshots`
  // throws, and the `.catch` sets the same flag. Kept because it is the version that
  // survives someone making the failure path non-throwing (`?? {}`), which is exactly the
  // edit that would silently reopen the defect.
  it("does not claim a wallet has no FMV history when the read failed", async () => {
    await loadChart(() => json(500, {}, false))
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load FMV history/))
    expect(document.body.textContent).toMatch(/says nothing about the wallet/)
    expect(document.body.textContent).not.toMatch(/No FMV history yet for this wallet/)
  })

  it("does claim a wallet has no FMV history when the read succeeded with none", async () => {
    await loadChart(() => json(200, { snapshots: [] }))
    await waitFor(() => expect(document.body.textContent).toMatch(/No FMV history yet for this wallet/))
    expect(document.body.textContent).not.toMatch(/Couldn't load FMV history/)
  })

  it("does not claim a wallet has no FMV history after a thrown fetch", async () => {
    await loadChart(() => { throw new Error("history network down") })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load FMV history/))
  })

  it("renders the portfolio history when snapshots loaded", async () => {
    const days = Array.from({ length: 10 }, (_, i) => ({
      snapshot_date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
      total_fmv: 1000 + i * 10,
      moment_count: 30,
    }))
    mount({
      wallets: () => json(200, { wallets: [WALLET()] }),
      snapshots: () => json(200, { snapshots: days }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
  })

  // ── 30-day portfolio change ────────────────────────────────────────────────
  // ⚠ THIS PAGE IS THE COPY-PASTED SIBLING of app/profile/[username]/ProfileClient,
  // where the `|| 1` divide-by-zero guard was found and fixed. The fix landed on
  // that file only; this one still substituted a $1 baseline. Same lesson as the two
  // saved_wallets loaders and the 15 OG cards — grep for the EXPRESSION, not the file.
  const SNAPS = (first: number, last: number) => [
    { snapshot_date: "2026-07-18", total_fmv: first, moment_count: 30 },
    { snapshot_date: "2026-08-16", total_fmv: last, moment_count: 34 },
  ]

  it("omits the 30D percentage when the baseline is ZERO rather than inventing one", async () => {
    // $0 -> $500 through `(500 - 0) / (0 || 1) * 100` reads "↑ 50000.0% / 30D".
    // A ratio against zero is UNDEFINED, not enormous.
    mount({
      wallets: () => json(200, { wallets: [WALLET()] }),
      snapshots: () => json(200, { snapshots: SNAPS(0, 500) }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).not.toMatch(/50000/)
    expect(document.body.textContent).not.toMatch(/%\s*\/\s*30D/)
  })

  it("still paints a zero-baseline GAIN in the up colour, not the loss colour", async () => {
    // ⚠ The half of this fix that is easy to miss: the sparkline colour keyed on
    // `sparkChange != null && sparkChange >= 0`, so merely nulling the ratio would
    // render a genuine 0 -> $500 gain RED — and only on the rows the null exists for.
    mount({
      wallets: () => json(200, { wallets: [WALLET()] }),
      snapshots: () => json(200, { snapshots: SNAPS(0, 500) }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    const stroke =
      document.body.querySelector("polyline")?.getAttribute("stroke") ??
      document.body.querySelector("svg path")?.getAttribute("stroke")
    expect(stroke).toBe("#34D399")
  })

  it("still reports a real percentage when the baseline is positive", async () => {
    // The other direction: the fix must not swallow a legitimate change, or it
    // trades a false number for a missing one.
    mount({
      wallets: () => json(200, { wallets: [WALLET()] }),
      snapshots: () => json(200, { snapshots: SNAPS(100, 150) }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/50\.0%\s*\/\s*30D/)
  })

  it("marks a real LOSS as down", async () => {
    mount({
      wallets: () => json(200, { wallets: [WALLET()] }),
      snapshots: () => json(200, { snapshots: SNAPS(200, 100) }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Damian Lillard/))
    expect(document.body.textContent).toMatch(/50\.0%\s*\/\s*30D/)
    expect(document.body.textContent).toContain("\u2193")
  })

  it("renders sniper deals when the feed has them", async () => {
    mount({
      sniper: () => json(200, {
        deals: [{
          playerName: "Stephen Curry", tier: "COMMON", askPrice: 5,
          adjustedFmv: 20, discount: 75, buyUrl: "https://example.test",
        }],
      }),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/Stephen Curry/))
    expect(document.body.textContent).toMatch(/-75%/)
  })
})
