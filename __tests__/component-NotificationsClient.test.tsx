// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react"

// The email-preferences surface, split out of app/dashboard/notifications/page.tsx.
//
// ⚠ WHY THESE TESTS EXIST AT ALL. The split is a MEASUREMENT change: a
// `"use client"` page.tsx is matched by neither coverage gate, so this state
// machine was invisible to both. Moving the body to `*Client.tsx` puts it in the
// component gate's measured set — which means landing it WITHOUT tests would
// drag the gate's aggregate down and red CI on arrival. The conversion and its
// coverage are one commit for that reason, not out of tidiness.
//
// What is worth pinning here is not layout. It is that this is the only surface
// a collector uses to control what email we send them, so:
//   • a failed hydrate must not render as "you are subscribed to nothing";
//   • the four ?confirm= banners must stay distinguishable;
//   • the save path's three notes say materially different things about whether
//     alerts are actually live.

let searchParams = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

import NotificationsClient from "@/app/dashboard/notifications/NotificationsClient"

const SUB = {
  id: "s1",
  email: "collector@example.com",
  verified: true,
  wallet_address: null,
  digest_weekly: true,
  deal_alerts: true,
  badge_alerts: false,
  portfolio_alerts: false,
  collection_ids: ["95f28a17-224a-4025-96ad-adf8a4c63bfd"],
  deal_min_discount: 35,
  deal_max_price: 250,
  deal_tiers: ["RARE"],
  unsubscribed_at: null,
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const fail = (status = 503) => ({
  ok: false,
  status,
  json: async () => ({ error: "Service temporarily unavailable" }),
})

beforeEach(() => {
  searchParams = new URLSearchParams()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("NotificationsClient — hydrate", () => {
  it("renders the collector's saved preferences", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)

    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())
    expect(screen.getByText(/verified/)).toBeTruthy()
    // Deal filters only mount when deal_alerts hydrated true — proving the
    // saved value drove the form rather than the defaults.
    expect(screen.getByText("Deal filters")).toBeTruthy()
    expect((screen.getByDisplayValue("35") as HTMLInputElement).value).toBe("35")
    expect((screen.getByDisplayValue("250") as HTMLInputElement).value).toBe("250")
  })

  it("a failed hydrate says so — it does not render an empty preference set", async () => {
    // ⚠ THE POINT. Every checkbox on this page defaults to a value, so a failed
    // read that fell through silently would draw a complete, plausible and WRONG
    // picture of what this collector has signed up for — and the Save button
    // sits right below it, so acting on it would overwrite the real settings.
    vi.stubGlobal("fetch", vi.fn(async () => fail() as any))
    render(<NotificationsClient />)

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load your notification settings/)).toBeTruthy(),
    )
    // ...and it must not claim an identity it never read.
    expect(screen.queryByText("collector@example.com")).toBeNull()
  })

  it("surfaces the server's own message when the body carries one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ error: "Sign in to manage alerts" }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Sign in to manage alerts")).toBeTruthy())
  })

  it("a brand-new collector with no subscriber row is NOT an error", async () => {
    // The other direction: `subscriber: null` is a real answer — this person
    // simply has not subscribed — and must reach the form, not the error box.
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: null }) as any))
    render(<NotificationsClient />)

    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    expect(screen.queryByText(/Couldn't load/)).toBeNull()
  })
})

describe("NotificationsClient — the four ?confirm= outcomes stay distinguishable", () => {
  const CASES: Array<[string, RegExp]> = [
    ["ok", /Email confirmed/],
    ["missing", /Missing confirmation token/],
    ["unknown_token", /invalid or already used/],
    ["error", /Confirmation failed/],
  ]

  it.each(CASES)("?confirm=%s renders its own banner", async (value, rx) => {
    searchParams = new URLSearchParams(`confirm=${value}&detail=smtp`)
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)

    await waitFor(() => expect(screen.getByText(rx)).toBeTruthy())
  })

  it("no ?confirm= renders no banner at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    for (const [, rx] of CASES) expect(screen.queryByText(rx)).toBeNull()
  })

  it("the error banner names the detail it was given", async () => {
    searchParams = new URLSearchParams("confirm=error&detail=mailbox_full")
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText(/mailbox_full/)).toBeTruthy())
  })
})

describe("NotificationsClient — save", () => {
  function hydrateThen(saveResponse: unknown) {
    let call = 0
    // ⚠ The parameters are declared even though they are unused: `vi.fn(async () => …)`
    // infers a ZERO-length args tuple, so `mock.calls[i][1]` is a type error
    // (TS2493) and the assertion below cannot be written at all. This is the
    // repo's most-repeated CI breakage — type the mock at creation.
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1 ? ok({ subscriber: SUB }) : saveResponse) as any
    })
  }

  it("posts the current form state, not the hydrated state", async () => {
    const f = hydrateThen(ok({ id: "s1", email: SUB.email, verified: true }))
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())

    fireEvent.click(screen.getByText("Badge alerts"))
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.badge_alerts).toBe(true)
    expect(body.deal_min_discount).toBe(35)
  })

  it("an unverified save that sent a confirmation says the alerts are NOT live yet", async () => {
    // The three notes are not cosmetic: this one is the only thing telling a
    // collector their alerts will not fire until they click the email.
    vi.stubGlobal(
      "fetch",
      hydrateThen(ok({ id: "s1", email: SUB.email, verified: false, confirmation_email_sent: true })),
    )
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText(/Confirmation email sent/)).toBeTruthy())
  })

  it("a failed confirmation email is reported, not silently treated as saved", async () => {
    vi.stubGlobal(
      "fetch",
      hydrateThen(
        ok({ id: "s1", email: SUB.email, verified: false, confirmation_email_error: "bounced" }),
      ),
    )
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText(/confirmation email failed: bounced/)).toBeTruthy())
  })

  it("a failed save reports the error and does not claim success", async () => {
    vi.stubGlobal("fetch", hydrateThen(fail(500)))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Service temporarily unavailable")).toBeTruthy())
    expect(screen.queryByText(/Preferences saved/)).toBeNull()
  })

  it("a thrown save is caught and reported", async () => {
    let call = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1
        if (call === 1) return ok({ subscriber: SUB }) as any
        throw new TypeError("Failed to fetch")
      }),
    )
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Failed to fetch")).toBeTruthy())
  })
})

describe("NotificationsClient — the toggle arrays add AND remove", () => {
  it("a tier chip toggles off again, and the deal panel hides when deal alerts do", async () => {
    // `toggleArray` is the one piece of real logic here; a test that only ever
    // clicks once would pass against an implementation that can only ADD.
    const f = vi.fn(async () => ok({ subscriber: SUB }) as any)
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())

    // RARE hydrated selected; click removes it, clicking again re-adds.
    const rare = screen.getByRole("button", { name: "RARE" })
    const selectedBg = rare.style.background
    fireEvent.click(rare)
    expect(rare.style.background).not.toBe(selectedBg)
    fireEvent.click(rare)
    expect(rare.style.background).toBe(selectedBg)

    // Turning deal alerts off unmounts the whole filter panel.
    fireEvent.click(screen.getByText("Deal alerts"))
    expect(screen.queryByText("Deal filters")).toBeNull()
  })

  it("a collection chip toggles independently of the tier chips", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())

    const ts = screen.getByRole("button", { name: "NBA Top Shot" })
    const rare = screen.getByRole("button", { name: "RARE" })
    const rareBefore = rare.style.background
    fireEvent.click(ts)
    expect(rare.style.background).toBe(rareBefore)
  })

  it("every 'what to receive' checkbox is independently wired", async () => {
    // Four near-identical handlers is exactly where a copy-paste slip puts two
    // labels on one setter, and the page would still look right — both boxes
    // move together only when you happen to click both.
    let call = 0
    const f = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1
        ? ok({ subscriber: { ...SUB, digest_weekly: false, portfolio_alerts: false } })
        : ok({ id: "s1", email: SUB.email, verified: true })) as any
    })
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("What to receive")).toBeTruthy())

    fireEvent.click(screen.getByText("Weekly digest"))
    fireEvent.click(screen.getByText("Portfolio alerts"))
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.digest_weekly).toBe(true)
    expect(body.portfolio_alerts).toBe(true)
    // ...and the ones never touched kept their hydrated values.
    expect(body.deal_alerts).toBe(true)
    expect(body.badge_alerts).toBe(false)
  })

  it("a minimum discount of 0 is silently rewritten to 20 — pinned as CURRENT behaviour", async () => {
    // ⚠ `parseInt(e.target.value, 10) || 20`. Zero is falsy, so a collector who
    // deliberately types 0 ("alert me on anything below FMV") gets 20 instead,
    // with no indication. Recorded rather than endorsed: the input's own
    // `min={5}` says 0 was never a supported value, so the fallback is doing a
    // clamp's job badly rather than corrupting a legitimate setting — but the
    // same expression also swallows a cleared field, which is how a user hits it.
    let call = 0
    const f = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1 ? ok({ subscriber: SUB }) : ok({ id: "s1", email: SUB.email, verified: true })) as any
    })
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())

    fireEvent.change(screen.getByDisplayValue("35"), { target: { value: "0" } })
    fireEvent.click(screen.getByText("Save preferences"))
    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    expect(JSON.parse((f.mock.calls[1][1] as RequestInit).body as string).deal_min_discount).toBe(20)
  })

  it("a real minimum discount survives the same expression", async () => {
    // The other direction, so the case above cannot be "read" as the fallback
    // firing for everything.
    let call = 0
    const f = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1 ? ok({ subscriber: SUB }) : ok({ id: "s1", email: SUB.email, verified: true })) as any
    })
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())

    fireEvent.change(screen.getByDisplayValue("35"), { target: { value: "45" } })
    fireEvent.change(screen.getByDisplayValue("250"), { target: { value: "99" } })
    fireEvent.click(screen.getByText("Save preferences"))
    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.deal_min_discount).toBe(45)
    expect(body.deal_max_price).toBe(99)
  })

  it("a blank max price posts null rather than 0", async () => {
    // `maxPrice ? Number(maxPrice) : null` — "" is falsy, and Number("") is 0.
    // A 0 cap would mean "no deal may cost anything", silencing every alert.
    let call = 0
    const f = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1
        ? ok({ subscriber: { ...SUB, deal_max_price: null } })
        : ok({ id: "s1", email: SUB.email, verified: true })) as any
    })
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("Deal filters")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.deal_max_price).toBeNull()
  })
})
