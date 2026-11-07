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
    // The digest switch reflects the saved value (SUB has it on); a hydrate of
    // `false` must untick it — proving the saved value drove the form.
    expect((screen.getByLabelText("Weekly digest") as HTMLInputElement).checked).toBe(true)
  })

  it("a saved digest_weekly=false hydrates as unticked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: { ...SUB, digest_weekly: false } }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())
    expect((screen.getByLabelText("Weekly digest") as HTMLInputElement).checked).toBe(false)
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

  // 2026-10-10: the comment above named the hazard but nothing enforced it —
  // Save stayed live over the defaults. After a failed load it is disabled, and
  // a click posts nothing.
  it("a failed hydrate DISABLES Save, so the defaults can never overwrite the real settings", async () => {
    const f = vi.fn(async () => fail() as any)
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText(/Couldn't load your notification settings/)).toBeTruthy())
    const save = screen.getByRole("button", { name: /Save preferences/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(f.mock.calls.some((c: any[]) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
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
    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())

    fireEvent.click(screen.getByLabelText("Weekly digest"))
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.digest_weekly).toBe(false)
    // The flags this page no longer shows are posted back AS HYDRATED, never
    // reset — a sender wired later must find what the collector saved.
    expect(body.deal_alerts).toBe(true)
    expect(body.badge_alerts).toBe(false)
    expect(body.deal_min_discount).toBe(35)
    expect(body.deal_max_price).toBe(250)
    expect(body.deal_tiers).toEqual(["RARE"])
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

describe("NotificationsClient — only switches a sender honours are offered (2026-11-06)", () => {
  // No sender reads email_subscribers.deal_alerts / badge_alerts / portfolio_alerts
  // (build_deal_alerts_for_subscriber has no caller — prosrc, cron.job and repo
  // grep), so offering those toggles promised email that could never arrive.
  // The page keeps the one switch the digest senders read and points listing
  // alerts at /alerts, which does send.
  it("offers Weekly digest only — no deal / badge / portfolio toggles, no deal-filter panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.queryByText("Deal alerts")).toBeNull()
    expect(screen.queryByText("Badge alerts")).toBeNull()
    expect(screen.queryByText("Portfolio alerts")).toBeNull()
    expect(screen.queryByText("Deal filters")).toBeNull()
    expect(screen.queryByRole("button", { name: "RARE" })).toBeNull()
  })

  it("says the digest is not sending yet, and routes listing alerts to /alerts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ subscriber: SUB }) as any))
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())
    expect(screen.getByText(/isn.t sending it yet/)).toBeTruthy()
    const alertsLinks = screen.getAllByRole("link", { name: "Alerts" })
    expect(alertsLinks.length).toBeGreaterThanOrEqual(1)
    expect(alertsLinks[0].getAttribute("href")).toBe("/alerts")
    expect(screen.getByRole("link", { name: /Dashboard/ }).getAttribute("href")).toBe("/dashboard")
  })

  it("a hydrated null max price posts null rather than 0", async () => {
    // The pass-through must not coerce: `maxPrice ? Number(maxPrice) : null` on
    // a hydrated "" stays null (a 0 cap would silence every alert if wired).
    let call = 0
    const f = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1
      return (call === 1
        ? ok({ subscriber: { ...SUB, deal_max_price: null } })
        : ok({ id: "s1", email: SUB.email, verified: true })) as any
    })
    vi.stubGlobal("fetch", f)
    render(<NotificationsClient />)
    await waitFor(() => expect(screen.getByText("collector@example.com")).toBeTruthy())
    fireEvent.click(screen.getByText("Save preferences"))

    await waitFor(() => expect(screen.getByText("Preferences saved.")).toBeTruthy())
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string)
    expect(body.deal_max_price).toBeNull()
  })
})
