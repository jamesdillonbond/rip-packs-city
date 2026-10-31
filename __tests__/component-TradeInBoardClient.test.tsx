// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// /insights/trade-in. The server rows render first; a player search and the sort
// tabs refetch the route; the wallet arm reads a wallet's per-player trade-in
// value. Honesty: a failed refetch clears the board and says so (never "no
// editions"); an unindexed wallet reads as unindexed (never "holds nothing"); a
// Moment without an ASP is counted beside its total, never valued at $0.

import TradeInBoardClient from "@/app/insights/trade-in/TradeInBoardClient"
import type { TradeInRow } from "@/lib/insights/trade-in-board"

const row = (o: Partial<TradeInRow> = {}): TradeInRow => ({
  edition_id: "e1",
  external_id: "90:2968::2",
  player_name: "Nikola Jokić",
  team_name: "Denver Nuggets",
  set_name: "Base Set",
  printing: "Torn",
  tier: "COMMON",
  series: 5,
  circulation_count: 1000,
  live_supply: 817,
  asp: 5.26,
  low_ask: 0.35,
  moments_per_pack: 2,
  cost_per_pack: 0.7,
  asp_to_ask: 15.03,
  asp_at: "2026-10-31T16:13:00Z",
  ...o,
})

type Answer = { status: number; body: unknown }
let answers: Record<string, Answer>
let urls: string[]

beforeEach(() => {
  answers = {}
  urls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const a = answers[url]
    if (!a) throw new Error(`unexpected fetch ${url}`)
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body } as Response
  }) as typeof fetch
})
afterEach(cleanup)

describe("TradeInBoardClient", () => {
  it("renders the server rows with Top Shot's figures, a decoded series tag and the drill-down link", () => {
    render(<TradeInBoardClient initialRows={[row(), row({ edition_id: "e2", printing: "Standard", series: 3, live_supply: null, circulation_count: 4000 })]} initialFetchedAt="2026-10-31T17:00:00Z" />)
    expect(screen.getAllByText("Nikola Jokić")).toHaveLength(2)
    expect(screen.getByText("Torn · common")).toBeTruthy()
    // on-chain 3 is Summer 2021 on Top Shot, never "S3"
    expect(screen.queryByText(/· S3$/)).toBeNull()
    expect(screen.getByText("817 live")).toBeTruthy()
    expect(screen.getByText("/4,000")).toBeTruthy()
    expect(screen.getAllByText("$5.26").length).toBeGreaterThan(0)
    expect(screen.getAllByText("15×").length).toBeGreaterThan(0)
    expect(screen.getAllByText("$0.70").length).toBeGreaterThan(0)
    const link = screen.getAllByText("Nikola Jokić")[0].closest("a")!
    expect(link.getAttribute("href")).toBe("/nba-top-shot/edition/90%3A2968%3A%3A2")
    expect(screen.getByText(/Updated Oct 31/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/FMV|HIGH|MEDIUM|LOW/)
  })

  it("a failed server read renders the banner and no data time, never 'no edition'", () => {
    render(<TradeInBoardClient initialRows={[]} initialFailed initialFetchedAt={null} />)
    expect(screen.getByText(/Couldn't load this view just now/)).toBeTruthy()
    expect(screen.queryByText(/No edition has both/)).toBeNull()
    expect(screen.getByText(/the read did not complete/)).toBeTruthy()
  })

  it("a player search and a sort tab refetch the route; a failed refetch clears the board and says so", async () => {
    render(<TradeInBoardClient initialRows={[row()]} initialFetchedAt="2026-10-31T17:00:00Z" />)
    answers["/api/public/insights/trade-in?sort=cost&limit=200&player=jokic"] = { status: 200, body: { rows: [row({ edition_id: "e9", player_name: "Nikola Jokić", set_name: "Metallic Gold LE" })], meta: { fetched_at: "2026-10-31T17:30:00Z" } } }
    fireEvent.change(screen.getByLabelText("Player"), { target: { value: " jokic " } })
    fireEvent.click(screen.getByText("Find"))
    await waitFor(() => expect(screen.getByText(/Metallic Gold LE/)).toBeTruthy())
    expect(screen.getByText(/Showing jokic/)).toBeTruthy()
    answers["/api/public/insights/trade-in?sort=ratio&limit=200&player=jokic"] = { status: 503, body: { error: "unavailable" } }
    fireEvent.click(screen.getByText("Counts most vs cost"))
    await waitFor(() => expect(screen.getByText(/Couldn't load this view just now/)).toBeTruthy())
    expect(screen.queryByText(/Metallic Gold LE/)).toBeNull()
    answers["/api/public/insights/trade-in?sort=ratio&limit=200"] = { status: 200, body: { rows: [] } }
    fireEvent.click(screen.getByText("Clear"))
    await waitFor(() => expect(screen.getByText(/No edition has both a Top Shot average sale price/)).toBeTruthy())
    expect(urls).toHaveLength(3)
  })

  it("the wallet arm: unindexed reads as unindexed; a portfolio sums packs, shows the cap, and clicking a player searches it", async () => {
    render(<TradeInBoardClient initialRows={[row()]} initialFetchedAt="2026-10-31T17:00:00Z" />)
    const input = screen.getByLabelText("Top Shot wallet address")
    answers["/api/public/insights/trade-in?wallet=0xbd94cade097e50ac"] = { status: 200, body: { players: [], meta: { wallet: "0xbd94cade097e50ac", total_players: 0 } } }
    fireEvent.change(input, { target: { value: "0xbd94cade097e50ac" } })
    fireEvent.click(screen.getByText("Count my Moments"))
    await waitFor(() => expect(screen.getByText(/hasn't indexed any Top Shot Moments/)).toBeTruthy())
    const fill = { player_name: "LeBron James", packs: 811, to_next_pack: 3.41, edition_id: "e2", external_id: "26:401", set_name: "Base Set", printing: "Standard", tier: "COMMON", series: 2, asp: 5.25, low_ask: 2.82, moments_needed: 1, cost: 2.82 }
    answers["/api/public/insights/trade-in?wallet=0x00000000000000aa"] = {
      status: 200,
      body: {
        players: [
          { player_name: "LeBron James", moments: 92, moments_with_asp: 90, asp_total: 8116.59, packs: 811, to_next_pack: 3.41, total_players: 1332, fill },
          { player_name: "Damian Lillard", moments: 382, moments_with_asp: 382, asp_total: 4171.29, packs: 417, to_next_pack: 8.71, total_players: 1332, fill: null },
        ],
        next_pack: [
          { ...fill, player_name: "Jonathan Isaac", packs: 0, to_next_pack: 0.13, external_id: "218:8550", edition_id: "e9", asp: 0.21, low_ask: 0.18, cost: 0.18, series: 8 },
          { ...fill, player_name: "Eric Gordon", packs: 0, to_next_pack: 0.34, external_id: "51:1947", edition_id: "e8", asp: 0.3, low_ask: 0.19, moments_needed: 2, cost: 0.38, series: 4 },
        ],
        meta: { wallet: "0x00000000000000aa", total_players: 1332, players_with_fill: 1300, packs_total: 6723 },
      },
    }
    fireEvent.change(input, { target: { value: "0x00000000000000aa" } })
    fireEvent.click(screen.getByText("Count my Moments"))
    // the headline is the WHOLE wallet's packs (meta.packs_total), not the sum of the rows shown
    await waitFor(() => expect(screen.getByText(/6,723 packs across 1,332 players/)).toBeTruthy())
    expect(screen.getByText(/showing the 2 with the most ASP/)).toBeTruthy()
    expect(screen.getByText(/2 without an ASP/)).toBeTruthy()
    // the per-player fill: LeBron's cheapest way to pack 812 links the edition; Lillard has no priced listing (never a $0 buy)
    const lebronFill = screen.getByText("1 × $2.82").closest("a")!
    expect(lebronFill.getAttribute("href")).toBe("/nba-top-shot/edition/26%3A401")
    expect(screen.getByText("no priced listing right now")).toBeTruthy()
    // the cheapest-next-packs list, cheapest first, with the whole-wallet gap count and the multi-Moment caveat
    expect(screen.getByText("Cheapest next packs")).toBeTruthy()
    expect(screen.getByText(/32 of 1,332 players have no priced listing/)).toBeTruthy()
    expect(screen.getByText("2 × $0.19")).toBeTruthy()
    expect(screen.getByText(/one at this ask is confirmed, the next may cost more/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\$0\.00|FMV|HIGH|MEDIUM|LOW/)
    answers["/api/public/insights/trade-in?sort=cost&limit=200&player=Damian+Lillard"] = { status: 200, body: { rows: [row({ edition_id: "e3", player_name: "Damian Lillard" })], meta: {} } }
    window.scrollTo = vi.fn()
    fireEvent.click(screen.getByText("Damian Lillard", { selector: "button" }))
    await waitFor(() => expect(screen.getByText(/Showing Damian Lillard/)).toBeTruthy())
    // a failed wallet read says so, never "holds nothing"
    answers["/api/public/insights/trade-in?wallet=0x00000000000000ab"] = { status: 503, body: { error: "unavailable" } }
    fireEvent.change(input, { target: { value: "0x00000000000000ab" } })
    fireEvent.click(screen.getByText("Count my Moments"))
    await waitFor(() => expect(screen.getByText(/Couldn't read that wallet just now/)).toBeTruthy())
  })

  // 2026-10-31 (afternoon): the player pages and the dashboard link in with ?player= / ?wallet=;
  // each pre-runs its arm once on mount, with the server rows still underneath until it answers.
  it("?player= in the URL runs the finder on mount; ?wallet= runs the wallet arm", async () => {
    window.history.replaceState({}, "", "/insights/trade-in?player=Damian+Lillard&wallet=0x00000000000000aa")
    answers["/api/public/insights/trade-in?sort=cost&limit=200&player=Damian+Lillard"] = { status: 200, body: { rows: [row({ edition_id: "e3", player_name: "Damian Lillard", set_name: "Metallic Gold LE" })], meta: {} } }
    answers["/api/public/insights/trade-in?wallet=0x00000000000000aa"] = { status: 503, body: { error: "unavailable" } }
    render(<TradeInBoardClient initialRows={[row()]} initialFetchedAt="2026-10-31T17:00:00Z" />)
    await waitFor(() => expect(screen.getByText(/Showing Damian Lillard/)).toBeTruthy())
    expect(screen.getByText(/Metallic Gold LE/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Couldn't read that wallet just now/)).toBeTruthy())
    expect((screen.getByLabelText("Top Shot wallet address") as HTMLInputElement).value).toBe("0x00000000000000aa")
    window.history.replaceState({}, "", "/insights/trade-in")
  })
})
