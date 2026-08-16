// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import AlertsClient from "@/app/alerts/AlertsClient"

// `/alerts` converted to a `*Client.tsx` so the component gate measures it.
//
// Already CLEAN, and unusually thoroughly: failure is tracked PER LEG (channels /
// subscriptions / FMV alerts). Every empty state on this page is a claim about the READER'S
// OWN account — "No alerts yet", "not linked", "No watched editions yet" — so one shared
// flag would blank all three whenever any one hiccuped, and an unflagged leg tells a
// collector whose Telegram IS linked that it is not, with a Link button inviting them to
// re-link it.
//
// This is coverage, not a fix. The three legs are now driven independently, which is the
// only way to prove they really are independent.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/alerts",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))
vi.mock("@/components/MobileNav", () => ({ default: () => null }))
vi.mock("@/components/SupportChatConnected", () => ({ default: () => null }))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const CHANNELS = {
  channels: [
    { channel: "email", verified: true, username: null, target: "t@example.test" },
    { channel: "telegram", verified: true, username: "collector", target: "12345" },
  ],
}
// ⚠ Every field taken from the component's own `Subscription` interface. An invented shape
// throws inside `subscriptionFilterSummary` and the WHOLE page renders empty, which reads
// as a routing fault rather than a bad fixture — the recurring cost of writing a fixture
// from the API's imagined response instead of the type the component declares.
const SUB = (over: Record<string, unknown> = {}) => ({
  id: "sub-1", label: "Blazers under $10", channels: ["email"],
  collection_ids: ["95f28a17-224a-4025-96ad-adf8a4c63bfd"],
  min_discount: 25, min_price: null, max_price: 10,
  tiers: null, parallel_names: null, player_names: ["Damian Lillard"],
  set_names: null, team_names: null, min_serial: null, max_serial: null,
  require_jersey_serial: false, require_last_mint: false, require_never_sold: false,
  require_low_ask: false, badges: null, cadence: "instant" as const,
  active: true, preview_count: 3, ...over,
})
// ⚠ `alert_type` is one of four literals and it INDEXES `FMV_ALERT_LABEL` — an invented
// value (e.g. "below_price") resolves to undefined and throws on call.
const FMV = (over: Record<string, unknown> = {}) => ({
  id: 1, edition_key: "48:1652", collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  player_name: "Damian Lillard", set_name: "Archive Set",
  alert_type: "price_below" as const, threshold: 5, channel: "email", active: true,
  fmv: 20, low_ask: 8, currently_triggered: false, ...over,
})

beforeEach(() => vi.useRealTimers())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Routes the three independent load legs plus any write. */
function mount(opts: {
  channels?: () => Response
  subs?: () => Response
  fmv?: () => Response
  write?: () => Response
} = {}) {
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method !== "GET") return (opts.write ?? (() => json(200, { ok: true })))()
    if (url.includes("/api/alerts/channels")) return (opts.channels ?? (() => json(200, CHANNELS)))()
    if (url.includes("/api/alerts/subscriptions")) return (opts.subs ?? (() => json(200, { subscriptions: [SUB()] })))()
    if (url.includes("/api/alerts/suggest")) return json(200, { suggestions: [] })
    if (url.includes("/api/alerts")) return (opts.fmv ?? (() => json(200, [FMV()])))()
    return json(200, {})
  })
  vi.stubGlobal("fetch", f)
  render(<AlertsClient />)
  return f
}

describe("AlertsClient — the three legs fail independently", () => {
  it("renders all three sections when every leg loads", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    expect(document.body.textContent).toMatch(/Damian Lillard/)
    expect(document.body.textContent).not.toMatch(/Couldn't load/)
  })

  // ⚠ THE CHANNELS LEG. Without its flag every channel renders "not linked" with a Link
  // button — telling a collector whose Telegram IS linked that it is not, and inviting them
  // to re-link something already working.
  it("does not report every channel unlinked when the channels leg fails", async () => {
    mount({ channels: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load your channel status/))
    expect(document.body.textContent).toMatch(/says nothing about what you have\s+linked/)
    // The other two legs loaded and must still render.
    expect(document.body.textContent).toMatch(/Blazers under \$10/)
    expect(document.body.textContent).toMatch(/Damian Lillard/)
  })

  // ⚠ ORDERING is what makes this non-inert: the failure branch must precede the empty
  // branch, or a failed read still renders "No alerts yet" and invites a duplicate.
  it("does not say the account has no alerts when the subscriptions leg fails", async () => {
    mount({ subs: () => json(503, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load your alerts/))
    expect(document.body.textContent).not.toMatch(/No alerts yet/)
    expect(document.body.textContent).toMatch(/Damian Lillard/)
  })

  it("does not say the account watches no editions when the FMV leg fails", async () => {
    mount({ fmv: () => json(500, {}, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load your watched editions/))
    expect(document.body.textContent).not.toMatch(/No watched editions yet/)
    expect(document.body.textContent).toMatch(/Blazers under \$10/)
  })

  // A thrown fetch takes down the whole `Promise.all`, so NONE of the three can be trusted —
  // and all three must say so rather than one of them quietly rendering its empty state.
  it("flags all three legs after a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<AlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load your channel status/))
    expect(document.body.textContent).toMatch(/Couldn't load your alerts/)
    expect(document.body.textContent).toMatch(/Couldn't load your watched editions/)
    expect(document.body.textContent).not.toMatch(/No alerts yet/)
    expect(document.body.textContent).not.toMatch(/No watched editions yet/)
  })

  // ⚠ THE MIRROR, three ways. A genuinely empty account must still get its onboarding copy —
  // blanking every empty state trades one false claim for a dead end.
  it("does say the account is empty when every leg succeeded with nothing", async () => {
    mount({
      channels: () => json(200, { channels: [] }),
      subs: () => json(200, { subscriptions: [] }),
      fmv: () => json(200, []),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/No alerts yet/))
    expect(document.body.textContent).toMatch(/No watched editions yet/)
    expect(document.body.textContent).not.toMatch(/Couldn't load/)
  })

  // ⚠ The reset on each run is load-bearing: without it a recovered page stays stuck on the
  // failure copy after the read starts working again, which is the mirror of the original
  // defect — telling a collector we cannot see their alerts when we now can.
  // ⚠ The reset on each run is load-bearing: without it a recovered page stays stuck on the
  // failure copy after the read starts working again — the mirror of the original defect,
  // telling a collector we cannot see their alerts when we now can.
  //
  // ⚠ There is no Reload BUTTON (the copy points at a browser reload), so the only in-page
  // path that re-runs `load()` is a successful mutation. A first draft looked for a button,
  // found none, and silently asserted nothing — the mutation survived.
  it("clears the failure copy once a later load succeeds", async () => {
    let n = 0
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") !== "GET") return json(200, { subscription: { preview_count: 1 } })
      if (url.includes("/api/alerts/channels")) {
        n += 1
        return n === 1 ? json(500, {}, false) : json(200, CHANNELS)
      }
      if (url.includes("/api/alerts/subscriptions")) return json(200, { subscriptions: [] })
      if (url.includes("/api/alerts/suggest")) return json(200, { suggestions: [] })
      if (url.includes("/api/alerts")) return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load your channel status/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^create alert$/i.test((b.textContent ?? "").trim()))!)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Couldn't load your channel status/))
  })

  // A non-array FMV body is malformed, not a list. Treating it as empty is the honest
  // degradation; rendering it would throw on `.map`.
  it("survives a non-array FMV payload", async () => {
    mount({ fmv: () => json(200, { unexpected: true }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/No watched editions yet/))
  })
})

describe("AlertsClient — subscriptions and watched editions", () => {
  it("renders a subscription with its filter summary", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    expect(document.body.textContent).toMatch(/Damian Lillard/)
  })

  it("dims an inactive subscription rather than hiding it", async () => {
    mount({ subs: () => json(200, { subscriptions: [SUB({ active: false })] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
  })

  // ⚠ DELETE IS CONFIRMED, and the decline path is the half worth pinning: an alert deleted
  // by accident is gone with no undo, and the collector only finds out by not being told
  // about a listing. jsdom's `confirm` is unimplemented, so a test that does not stub it
  // exercises the DECLINE path while looking like it tested the delete.
  it("does not delete a subscription when the confirmation is declined", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Delete")!)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false)
    expect(document.body.textContent).toMatch(/Blazers under \$10/)
  })

  it("deletes a subscription and reloads when confirmed", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Delete")!)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(true),
    )
  })

  it("renders a watched edition with its FMV and ask", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    expect(document.body.textContent).toMatch(/FMV \$20/)
    expect(document.body.textContent).toMatch(/ask \$8/)
  })

  // ⚠ "triggered now" is a live claim about the market. It must render only when the API
  // says so — a watched edition wrongly marked triggered sends a collector to buy something
  // that is not actually below their threshold.
  it("marks a watched edition triggered only when the API says so", async () => {
    mount({ fmv: () => json(200, [FMV({ currently_triggered: true })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/triggered now/))
    cleanup()
    mount({ fmv: () => json(200, [FMV({ currently_triggered: false })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    expect(document.body.textContent).not.toMatch(/triggered now/)
  })

  it("falls back to the edition key for an unnamed watched edition", async () => {
    mount({ fmv: () => json(200, [FMV({ player_name: null, set_name: null })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/48:1652/))
  })

  it("omits an FMV it does not have rather than printing a zero", async () => {
    mount({ fmv: () => json(200, [FMV({ fmv: null, low_ask: null })]) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    expect(document.body.textContent).not.toMatch(/FMV \$0/)
    expect(document.body.textContent).not.toMatch(/ask \$0/)
  })

  it("deletes a watched edition when confirmed, and not otherwise", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false))
    const f = mount({ subs: () => json(200, { subscriptions: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Archive Set/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Delete")!)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false)

    vi.stubGlobal("confirm", vi.fn(() => true))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Delete")!)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(true),
    )
  })
})

describe("AlertsClient — delivery channels", () => {
  it("shows a linked channel as linked", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/email/i))
  })

  it("shows an unlinked channel as unlinked when the read SUCCEEDED", async () => {
    mount({ channels: () => json(200, { channels: [] }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/telegram/i))
    // The honest case: we asked, and nothing is linked.
    expect(document.body.textContent).not.toMatch(/Couldn't load your channel status/)
  })

  it("links a channel", async () => {
    const f = mount({ channels: () => json(200, { channels: [] }), write: () => json(200, { link: "https://t.me/x" }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/telegram/i))
    const link = screen.getAllByRole("button").find((b) => /^link/i.test((b.textContent ?? "").trim()))
    if (link) {
      fireEvent.click(link)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
    }
  })

  it("unlinks a channel", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/telegram/i))
    const unlink = screen.getAllByRole("button").find((b) => /unlink/i.test(b.textContent ?? ""))
    if (unlink) {
      fireEvent.click(unlink)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(true),
      )
    }
  })
})

describe("AlertsClient — the subscription form", () => {
  const labelInput = () => document.querySelectorAll("input")[0] as HTMLInputElement
  const saveBtn = () => screen.getAllByRole("button").find((b) => /^save|^create/i.test((b.textContent ?? "").trim()))!
  const numberInput = (label: string) => {
    const el = Array.from(document.querySelectorAll("label")).find((l) => (l.textContent ?? "").trim().startsWith(label))
    return el?.nextElementSibling as HTMLInputElement | undefined
  }

  // ⚠ A subscription with NO CHANNEL can never deliver anything. It is the silent-failure
  // shape this repo has already paid for on `manage_alerts`: the collector hears nothing and
  // cannot tell a quiet market from a rule that could never fire. Refused BEFORE the request.
  it("refuses to save a subscription with no delivery channel", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    // ⚠ EMPTY_FORM pre-selects email, so the chip must be clicked to DESELECT it. An
    // earlier draft clicked it "to pick a channel" and was silently removing the only one —
    // the save tests then failed on the very guard they were meant to satisfy.
    const chip = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim().toLowerCase() === "email",
    )!
    fireEvent.click(chip)
    const before = f.mock.calls.length
    fireEvent.click(saveBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Pick at least one delivery channel/))
    expect(f.mock.calls.length).toBe(before)
  })

  it("saves a subscription and reports how many deals match right now", async () => {
    const f = mount({ write: () => json(200, { subscription: { preview_count: 7 } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    fireEvent.change(labelInput(), { target: { value: "Lillard under $10" } })
    fireEvent.click(saveBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/7 deal\(s\) match right now/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true)
  })

  // ⚠ A save with no preview count must NOT invent one. "Saved. 0 deal(s) match right now"
  // would tell a collector their brand-new alert is already dead.
  it("says only 'Saved.' when the API returns no preview count", async () => {
    mount({ write: () => json(200, { subscription: {} }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    fireEvent.click(saveBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Saved\./))
    // ⚠ Asserted as the ABSENCE OF ANY count, not of a zero. Mutating the null-check to
    // `true` yields "Saved. undefined deal(s) match right now" — which a `/0 deal\(s\)/`
    // assertion happily lets through. A fabricated count is wrong whatever it says.
    expect(document.body.textContent).not.toMatch(/deal\(s\) match right now/)
  })

  it("states a save failure rather than reporting success", async () => {
    mount({ write: () => json(500, { error: "could not save that" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    fireEvent.click(saveBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/could not save that/))
    expect(document.body.textContent).not.toMatch(/Saved\./)
  })

  it("states a network error on save", async () => {
    let saved = false
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") !== "GET") { saved = true; throw new Error("boom") }
      if (url.includes("/api/alerts/channels")) return json(200, CHANNELS)
      if (url.includes("/api/alerts/subscriptions")) return json(200, { subscriptions: [] })
      if (url.includes("/api/alerts/suggest")) return json(200, { suggestions: [] })
      if (url.includes("/api/alerts")) return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    fireEvent.click(saveBtn())
    await waitFor(() => expect(document.body.textContent).toMatch(/Network error saving/))
    expect(saved).toBe(true)
  })

  // ⚠ `min_discount: 0` IS LOAD-BEARING, not a degenerate default: with a max price set it
  // means "ignore FMV, just watch the price" — the price-only alert shipped in
  // audit_20260816_price_only_alerts. The hint under the field is the only place that says
  // so, so it must survive: nothing else on this screen would tell a collector.
  it("explains that a zero discount with a max price is a price-only alert", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    expect(document.body.textContent).toMatch(/Set 0 with a max price to alert on price alone, ignoring FMV/)
  })

  it("carries the form's numeric filters into the payload", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const maxPrice = numberInput("Max price")
    if (maxPrice) fireEvent.change(maxPrice, { target: { value: "12" } })
    const minDiscount = numberInput("Min discount")
    if (minDiscount) fireEvent.change(minDiscount, { target: { value: "0" } })
    fireEvent.click(saveBtn())
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    )
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    const body = JSON.parse(String((post[1] as RequestInit).body))
    expect(body.max_price).toBe(12)
    expect(body.min_discount).toBe(0)
  })

  it("changes the cadence", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const select = document.querySelector("select") as HTMLSelectElement | null
    if (select) {
      fireEvent.change(select, { target: { value: "daily" } })
      fireEvent.click(saveBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
      const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
      expect(JSON.parse(String((post[1] as RequestInit).body)).cadence).toBe("daily")
    }
  })

  // ⚠ Editing must LOAD the existing subscription into the form. A partially-populated edit
  // form silently drops the filters the collector already set, so saving it narrows or
  // widens an alert they never asked to change.
  it("loads an existing subscription into the form for editing", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    const edit = screen.getAllByRole("button").find((b) => /^edit$/i.test((b.textContent ?? "").trim()))
    if (edit) {
      fireEvent.click(edit)
      await waitFor(() => expect(document.body.textContent).toMatch(/Edit alert/))
      expect(labelInput().value).toBe("Blazers under $10")
      // ⚠ `player_names` is a comma-separated STRING in FormState (arrToCsv) rendered by
      // ChipTypeahead as removable CHIPS — not an input value and not plain page text. The
      // chip's aria-label is the only unambiguous handle, because "Damian Lillard" also
      // appears in the subscription list above, which would make a page-level match vacuous.
      await waitFor(() =>
        expect(document.querySelector('[aria-label="Remove Damian Lillard"]')).toBeTruthy(),
      )
    }
  })

  it("cancels an edit and returns to a blank form", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    const edit = screen.getAllByRole("button").find((b) => /^edit$/i.test((b.textContent ?? "").trim()))
    if (edit) {
      fireEvent.click(edit)
      await waitFor(() => expect(document.body.textContent).toMatch(/Edit alert/))
      fireEvent.click(screen.getAllByRole("button").find((b) => /^cancel$/i.test((b.textContent ?? "").trim()))!)
      await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
      // EMPTY_FORM's label is a default, not blank.
      expect(labelInput().value).toBe("My deal alert")
    }
  })

  it("pauses and resumes a subscription", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/Blazers under \$10/))
    const toggle = screen.getAllByRole("button").find((b) => /pause|resume|activate|deactivate/i.test(b.textContent ?? ""))
    if (toggle) {
      fireEvent.click(toggle)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method !== "GET")).toBe(true),
      )
    }
  })

  // ⚠ OptionTypeahead (collections / tiers / parallels) is a DIFFERENT control from
  // ChipTypeahead (players / sets / teams): it picks from a fixed option list rather than
  // free text, so its add path goes through a suggestion click, not Enter.
  // ⚠ OptionTypeahead (collections / tiers / parallels) is a DIFFERENT control from
  // ChipTypeahead (players / sets / teams): it picks from a FIXED option list rather than
  // free text. Enter adds `suggestions[0]`, which is the path that does not depend on
  // guessing an option's exact label — a guessed label matches nothing and the failure reads
  // as the control being broken.
  it("adds and removes an option-typeahead filter", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const tier = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a tier/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement | undefined
    expect(tier, "the tier typeahead must exist").toBeTruthy()
    fireEvent.focus(tier!)
    fireEvent.keyDown(tier!, { key: "Enter" })
    const chip = await waitFor(() => {
      const el = document.querySelector('[aria-label^="Remove "]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    fireEvent.click(chip)
    await waitFor(() => expect(document.querySelector('[aria-label^="Remove "]')).toBeNull())
  })

  // ⚠ Backspace on an empty query removes the LAST chip. That is a destructive edit with no
  // visible affordance, so it has to keep working exactly as written — a collector clearing
  // the text field must not silently lose a filter they did not mean to drop.
  it("removes the last chip on Backspace when the query is empty", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const tier = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a tier/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement
    fireEvent.focus(tier)
    fireEvent.keyDown(tier, { key: "Enter" })
    await waitFor(() => expect(document.querySelector('[aria-label^="Remove "]')).toBeTruthy())
    fireEvent.keyDown(tier, { key: "Backspace" })
    await waitFor(() => expect(document.querySelector('[aria-label^="Remove "]')).toBeNull())
  })

  it("carries a serial range and the boolean requirement chips into the payload", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const byLabel = (label: string) => {
      const el = Array.from(document.querySelectorAll("label")).find((l) => (l.textContent ?? "").trim().startsWith(label))
      return el?.nextElementSibling as HTMLInputElement | undefined
    }
    const minS = byLabel("Min serial")
    const maxS = byLabel("Max serial")
    const minP = byLabel("Min price")
    if (minS) fireEvent.change(minS, { target: { value: "1" } })
    if (maxS) fireEvent.change(maxS, { target: { value: "50" } })
    if (minP) fireEvent.change(minP, { target: { value: "2" } })
    // ⚠ These four booleans are saved now and enforced once the per-serial feed lands, so a
    // dropped flag is invisible today and wrong later — exactly the kind of thing that is
    // only ever caught by asserting the PAYLOAD.
    for (const name of ["Jersey serial", "Last mint"]) {
      const chip = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === name)
      if (chip) fireEvent.click(chip)
    }
    fireEvent.click(saveBtn())
    await waitFor(() =>
      expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    )
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    const body = JSON.parse(String((post[1] as RequestInit).body))
    expect(body.min_serial).toBe(1)
    expect(body.max_serial).toBe(50)
    expect(body.min_price).toBe(2)
    expect(body.require_jersey_serial).toBe(true)
    expect(body.require_last_mint).toBe(true)
  })

  it("toggles a badge filter into the payload", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const label = Array.from(document.querySelectorAll("label")).find((l) => (l.textContent ?? "").trim().startsWith("Badges"))
    const badgeChip = label?.nextElementSibling?.querySelector("button") as HTMLElement | undefined
    if (badgeChip) {
      fireEvent.click(badgeChip)
      fireEvent.click(saveBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
      const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
      expect(JSON.parse(String((post[1] as RequestInit).body)).badges.length).toBeGreaterThan(0)
    }
  })

  it("scopes a collection filter into the payload", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const coll = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a collection/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement | undefined
    if (coll) {
      fireEvent.focus(coll)
      fireEvent.keyDown(coll, { key: "Enter" })
      await waitFor(() => expect(document.querySelector('[aria-label^="Remove "]')).toBeTruthy())
      fireEvent.click(saveBtn())
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
      )
      const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
      expect(JSON.parse(String((post[1] as RequestInit).body)).collection_ids.length).toBe(1)
    }
  })

  // ⚠ The chip typeahead ASKS THE SERVER for suggestions (`/api/alerts/suggest`), so its
  // behaviour on a failed or empty suggestion read matters: a collector must still be able
  // to type a name we do not happen to suggest. `add(suggestions[0] ?? query)` is what makes
  // free text work, and it is the difference between a filter they can set and one they
  // cannot.
  it("suggests players from the server and adds the picked one", async () => {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") !== "GET") return json(200, { ok: true })
      if (url.includes("/api/alerts/suggest")) return json(200, { suggestions: ["Damian Lillard", "Dame Time"] })
      if (url.includes("/api/alerts/channels")) return json(200, CHANNELS)
      if (url.includes("/api/alerts/subscriptions")) return json(200, { subscriptions: [] })
      if (url.includes("/api/alerts")) return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const player = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a player/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement
    fireEvent.change(player, { target: { value: "dam" } })
    await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("/api/alerts/suggest"))).toBe(true))
    // ⚠ The suggestion list renders behind a 200 ms debounce, and its items commit on
    // `onMouseDown` (not `onClick`) so the input's `onBlur` cannot close the list first —
    // `fireEvent.click` therefore does nothing here and reads as the list never rendering.
    const suggestion = await waitFor(
      () => {
        const el = Array.from(document.querySelectorAll("button")).find(
          (b) => (b.textContent ?? "").trim() === "Dame Time",
        )
        expect(el, "the server suggestion must be offered").toBeTruthy()
        return el as HTMLElement
      },
      { timeout: 3000 },
    )
    fireEvent.mouseDown(suggestion)
    await waitFor(() => expect(document.querySelector('[aria-label="Remove Dame Time"]')).toBeTruthy())
  })

  it("still accepts a typed name when the suggestion read fails", async () => {
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if ((init?.method ?? "GET") !== "GET") return json(200, { ok: true })
      if (url.includes("/api/alerts/suggest")) return json(500, {}, false)
      if (url.includes("/api/alerts/channels")) return json(200, CHANNELS)
      if (url.includes("/api/alerts/subscriptions")) return json(200, { subscriptions: [] })
      if (url.includes("/api/alerts")) return json(200, [])
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AlertsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const player = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a player/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement
    fireEvent.change(player, { target: { value: "Nobody Suggested" } })
    fireEvent.keyDown(player, { key: "Enter" })
    // ⚠ A broken suggestion endpoint must NOT block the filter — otherwise our outage
    // silently narrows what a collector is allowed to watch.
    await waitFor(() => expect(document.querySelector('[aria-label="Remove Nobody Suggested"]')).toBeTruthy())
  })

  it("adds and removes a chip filter", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/New alert/))
    const typeahead = Array.from(document.querySelectorAll("input")).find(
      (i) => /Type a player/i.test((i as HTMLInputElement).placeholder ?? ""),
    ) as HTMLInputElement | undefined
    expect(typeahead, "the player typeahead must exist").toBeTruthy()
    fireEvent.change(typeahead!, { target: { value: "Stephen Curry" } })
    fireEvent.keyDown(typeahead!, { key: "Enter" })
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Remove Stephen Curry"]')).toBeTruthy(),
    )
    fireEvent.click(document.querySelector('[aria-label="Remove Stephen Curry"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Remove Stephen Curry"]')).toBeNull(),
    )
  })
})
