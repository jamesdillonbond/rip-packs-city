// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// /trades/compare (2026-11-16). States kept apart: a refusal names the problem, a failed read is a
// banner with Retry (never "nothing to trade"), a short index says so. FMV renders only where
// priced ("not priced" otherwise, never $0); no wallet address, no confidence tier.

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => nav.params,
}))

import CompareClient from "@/app/trades/compare/CompareClient"

type Answer = { status: number; body: unknown }
const me = { status: 200, body: { user: null } as unknown }
let answers: Array<(url: string, init?: RequestInit) => Answer | null>

beforeEach(() => {
  nav.push.mockReset()
  nav.replace.mockReset()
  nav.params = new URLSearchParams()
  answers = []
  me.body = { user: null }
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === "/api/profile/me") return { ok: me.status === 200, status: me.status, json: async () => me.body } as Response
    for (const a of answers) {
      const r = a(url, init)
      if (r) return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
})

afterEach(() => cleanup())

const ed = (o: Record<string, unknown> = {}) => ({
  edition_key: "227:7560",
  player_name: "Tre Mann",
  set_name: "Equinox",
  tier: "RARE",
  series_number: 8,
  league: "NBA",
  image_url: null,
  fmv_usd: 4.23,
  from_asks: true,
  owned: 2,
  tradeable: [{ moment_id: "50452811", serial_number: 135 }],
  blocked: { locked: 0, listed: 0, gone: 0 },
  ...o,
})

const side = (username: string, editions: unknown[], o: Record<string, unknown> = {}) => ({
  username,
  editions,
  editions_total: editions.length,
  candidates_total: editions.length,
  capped: false,
  blocked: { locked: 1, listed: 2, gone: 0 },
  coverage: { indexed: 100, on_chain: 100, complete: true },
  indexing: false,
  ...o,
})

const result = (o: Record<string, unknown> = {}) => ({
  a: side("Jamesdillonbond", [ed()]),
  b: side("roham", [
    ed({ edition_key: "13:89", player_name: "Andre Iguodala", set_name: "With the Strip", series_number: 0, fmv_usd: 6, from_asks: false, tradeable: [{ moment_id: "999", serial_number: 101 }] }),
    ed({ edition_key: "1:1", player_name: "Cam Reddish", set_name: "Rookie Debut", series_number: 0, fmv_usd: null, from_asks: false, tradeable: [{ moment_id: "777", serial_number: 47 }] }),
  ]),
  quick_trade: null,
  checked_at: "2026-11-16T18:00:00.000Z",
  ...o,
})

function compareWith(r: Answer) {
  answers.push((url) => (url.startsWith("/api/public/trades/compare") ? r : null))
}

function submit(a = "jamesdillonbond", b = "roham") {
  fireEvent.change(screen.getByLabelText("Your Top Shot username"), { target: { value: a } })
  fireEvent.change(screen.getByLabelText("Trade partner's Top Shot username"), { target: { value: b } })
  fireEvent.click(screen.getByRole("button", { name: "Compare" }))
}

describe("CompareClient", () => {
  it("renders both sides with FMV, 'from asks', 'not priced' (never $0) and what was left out", async () => {
    compareWith({ status: 200, body: result() })
    render(<CompareClient />)
    submit()
    await screen.findByText("@Jamesdillonbond could trade")
    expect(screen.getByText("$4.23")).toBeTruthy()
    expect(screen.getAllByText("from asks").length).toBeGreaterThan(0)
    expect(screen.getByText("not priced")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\$0\.00/)
    expect(document.body.textContent).toMatch(/Left out for @roham: 1 locked, 2 listed for sale/)
    expect(document.body.textContent).not.toMatch(/0x[0-9a-f]{16}|confidence|HIGH|MEDIUM/)
    expect(nav.replace).toHaveBeenCalledWith("/trades/compare?u1=jamesdillonbond&u2=roham", { scroll: false })
  })

  it("a 404 names the problem; a 503 is a banner with Retry, never 'nothing to trade'", async () => {
    compareWith({ status: 404, body: { error: 'No Top Shot collector named "nobody".' } })
    render(<CompareClient />)
    submit("jamesdillonbond", "nobody")
    await screen.findByText('No Top Shot collector named "nobody".')
    cleanup()
    answers = []
    compareWith({ status: 503, body: { error: "We couldn't read those collections just now." } })
    render(<CompareClient />)
    submit()
    await screen.findByText("We couldn't read those collections just now.")
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/No duplicates/)
  })

  it("a short index says so and that it is being read", async () => {
    compareWith({ status: 200, body: result({ b: side("roham", [], { coverage: { indexed: 10, on_chain: 50, complete: false }, indexing: true }) }) })
    render(<CompareClient />)
    submit()
    await screen.findByText(/RPC has read 10 of @roham's 50 Moments/)
    expect(document.body.textContent).toMatch(/reading the rest now/)
    expect(document.body.textContent).toMatch(/No duplicates @Jamesdillonbond doesn't own/)
  })

  it("Quick Trade loads into the builder; serial chips toggle; the plan link carries the picks", async () => {
    const qt = {
      a: { edition_key: "227:7560", moment_id: "50452811", serial_number: 135, player_name: "Tre Mann", set_name: "Equinox", fmv_usd: 4.23 },
      b: { edition_key: "13:89", moment_id: "999", serial_number: 101, player_name: "Andre Iguodala", set_name: "With the Strip", fmv_usd: 6 },
      difference_usd: -1.77,
    }
    compareWith({ status: 200, body: result({ quick_trade: qt }) })
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CompareClient />)
    submit()
    await screen.findByText(/\$1\.77 apart/)
    fireEvent.click(screen.getByRole("button", { name: "Load into the trade builder" }))
    expect(screen.getByRole("button", { name: "Remove serial 135 from the trade" }).getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Add serial 47 to the trade" }))
    expect(document.body.textContent).toMatch(/1 not priced/)
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this trade" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(String((writeText.mock.calls[0] as unknown[])[0])).toMatch(/\/trades\/compare\?u1=Jamesdillonbond&u2=roham&give=50452811&get=999%2C777$/)
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.queryByRole("button", { name: "Copy link to this trade" })).toBeNull()
  })

  it("Start a trade room: signed out asks to sign in (keeping the plan); signed in opens the room", async () => {
    compareWith({ status: 200, body: result() })
    let roomStatus = 401
    answers.push((url, init) => (url === "/api/trade-room" && init?.method === "POST" ? { status: roomStatus, body: roomStatus === 200 ? { room: { code: "abcdefghij" } } : { error: "Sign in" } } : null))
    render(<CompareClient />)
    submit()
    await screen.findByText("@Jamesdillonbond could trade")
    fireEvent.click(screen.getByRole("button", { name: "Add serial 135 to the trade" }))
    fireEvent.click(screen.getByRole("button", { name: "Start a trade room" }))
    const link = await screen.findByRole("link", { name: "Sign in" })
    expect(link.getAttribute("href")).toMatch(/^\/login\?next=%2Ftrades%2Fcompare%3Fu1%3DJamesdillonbond/)
    roomStatus = 200
    fireEvent.click(screen.getByRole("button", { name: "Start a trade room" }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/trades/abcdefghij"))
  })

  it("the room is started WITH the plan; a plan that didn't attach is said, with a link to the room", async () => {
    compareWith({ status: 200, body: result() })
    const sent: unknown[] = []
    let saved = false
    answers.push((url, init) => {
      if (url !== "/api/trade-room" || init?.method !== "POST") return null
      sent.push(JSON.parse(String(init.body)))
      return { status: 201, body: { room: { code: "abcdefghij" }, plan_saved: saved } }
    })
    render(<CompareClient />)
    submit()
    await screen.findByText("@Jamesdillonbond could trade")
    fireEvent.click(screen.getByRole("button", { name: "Add serial 135 to the trade" }))
    fireEvent.click(screen.getByRole("button", { name: "Add serial 101 to the trade" }))
    fireEvent.click(screen.getByRole("button", { name: "Start a trade room" }))
    const link = await screen.findByRole("link", { name: "Open the trade room" })
    expect(link.getAttribute("href")).toBe("/trades/abcdefghij")
    expect(nav.push).not.toHaveBeenCalled()
    expect(sent[0]).toEqual({ plan: { collection: "nba-top-shot", partner_username: "roham", give: ["50452811"], get: ["999"] } })
    saved = true
    fireEvent.click(screen.getByRole("button", { name: "Start a trade room" }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/trades/abcdefghij"))
  })

  it("filters: series, league, Rookie Debut only", async () => {
    compareWith({ status: 200, body: result() })
    render(<CompareClient />)
    submit()
    await screen.findByText("Cam Reddish")
    fireEvent.click(screen.getByRole("checkbox"))
    expect(screen.queryByText("Andre Iguodala")).toBeNull()
    expect(screen.getByText("Cam Reddish")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.change(screen.getByLabelText("Series"), { target: { value: "Series 2025-26" } })
    expect(screen.queryByText("Cam Reddish")).toBeNull()
    expect(screen.getByText("Tre Mann")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Series"), { target: { value: "" } })
    fireEvent.change(screen.getByLabelText("League"), { target: { value: "WNBA" } })
    expect(screen.queryByText("Tre Mann")).toBeNull()
  })

  it("a shared link runs on arrival and restores the planned picks", async () => {
    nav.params = new URLSearchParams("u1=Jamesdillonbond&u2=roham&give=50452811&get=999")
    compareWith({ status: 200, body: result() })
    render(<CompareClient />)
    await screen.findByText("@Jamesdillonbond could trade")
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove serial 101 from the trade" })).toBeTruthy())
    expect(screen.getByRole("button", { name: "Remove serial 135 from the trade" })).toBeTruthy()
  })

  it("empty usernames are refused without a read", () => {
    render(<CompareClient />)
    fireEvent.click(screen.getByRole("button", { name: "Compare" }))
    expect(screen.getByText("Enter two Top Shot usernames.")).toBeTruthy()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith("/api/public/trades/compare"))).toHaveLength(0)
  })

  it("signed in with a Top Shot username, 'You' is pre-filled; signed out or a failed read leaves it empty", async () => {
    me.body = { user: { id: "u", topshot_username: "Jamesdillonbond" } }
    render(<CompareClient />)
    await waitFor(() => expect((screen.getByLabelText("Your Top Shot username") as HTMLInputElement).value).toBe("Jamesdillonbond"))
    cleanup()
    me.status = 503
    me.body = { error: "down" }
    render(<CompareClient />)
    await new Promise((r) => setTimeout(r, 20))
    expect((screen.getByLabelText("Your Top Shot username") as HTMLInputElement).value).toBe("")
    me.status = 200
  })

  it("switching collection re-runs the same two collectors in that collection, with its own series names and no Top Shot-only filters", async () => {
    const calls: string[] = []
    answers.push((url) => {
      if (!url.startsWith("/api/public/trades/compare")) return null
      calls.push(url)
      return url.includes("c=nfl-all-day")
        ? { status: 200, body: result({ collection: "nfl-all-day", a: side("Jamesdillonbond", [ed({ edition_key: "ad:1", player_name: "Josh Allen", series_number: 2, from_asks: false, fmv_usd: 12 })], { blocked: { locked: 0, listed: 0, gone: 2 } }), b: side("roham", []) }) }
        : { status: 200, body: result() }
    })
    render(<CompareClient />)
    submit()
    await screen.findByText("Tre Mann")
    fireEvent.change(screen.getByLabelText("Collection"), { target: { value: "nfl-all-day" } })
    await screen.findByText("Josh Allen")
    expect(calls.at(-1)).toMatch(/u1=Jamesdillonbond&u2=roham&c=nfl-all-day$/)
    expect(nav.replace).toHaveBeenLastCalledWith("/trades/compare?u1=Jamesdillonbond&u2=roham&c=nfl-all-day", { scroll: false })
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByLabelText("League")).toBeNull()
    expect(screen.getByText(/All Day's locked Moments are held by Dapper/)).toBeTruthy()
  })
})
