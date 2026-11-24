// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import TeamSeriesChecklists from "@/components/entity/TeamSeriesChecklists"

// Drives the Series Checklists panel (2026-11-23): one row per series, owned/total, "N to go · $X",
// a Closest badge, a roster expand, and the three states — a failed read says so (never an empty
// team), an empty series list renders nothing, and an unlisted player is never priced as $0.

vi.mock("next/link", () => ({ default: ({ children, ...p }: { children?: React.ReactNode } & Record<string, unknown>) => <a {...(p as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a> }))

const res = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response)

const player = (name: string, over: Record<string, unknown> = {}) => ({
  player_key: name, player_name: name, owned: false, owned_count: 0, cheapest_ask_usd: 5,
  cheapest_route_slug: `${name}-slug`, cheapest_name: `${name} Base`, thumbnail_url: null, edition_count: 1, ...over,
})

const body = (wallet: boolean) => ({
  wallet_cached: wallet ? true : null,
  series: [
    { series_num: 9, players_total: 6, players_owned: wallet ? 5 : null, to_go: wallet ? 1 : 6, cost_to_go_usd: 12.5, unlisted: 0,
      complete: wallet ? false : null, players: [player("Cooper Flagg", { cheapest_ask_usd: 12.5 }), player("Kyrie Irving", { owned: wallet, owned_count: wallet ? 2 : 0 })] },
    { series_num: 7, players_total: 20, players_owned: wallet ? 17 : null, to_go: wallet ? 3 : 20, cost_to_go_usd: 40, unlisted: 1,
      complete: wallet ? false : null, players: [player("Luka Doncic", { cheapest_ask_usd: null, cheapest_route_slug: null })] },
    { series_num: 3, players_total: 2, players_owned: wallet ? 2 : null, to_go: wallet ? 0 : 2, cost_to_go_usd: wallet ? 0 : 1.9, unlisted: 0,
      complete: wallet ? true : null, players: [] },
  ],
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("TeamSeriesChecklists", () => {
  it("anonymous: every series with its whole roster and cost, no Closest badge, no owned counts", async () => {
    const fetchMock = vi.fn((_u: string) => res(true, body(false)))
    vi.stubGlobal("fetch", fetchMock)
    const { findByText, queryByText, getByText } = render(
      <TeamSeriesChecklists collectionUrlSlug="nba-top-shot" teamSlug="dallas-mavericks" teamLabel="the Dallas Mavericks" wallet={null} />,
    )
    expect(await findByText("2026-27")).toBeTruthy()
    expect(getByText("Summer 2021")).toBeTruthy()
    expect(getByText("6 players")).toBeTruthy()
    expect(getByText(/every player on the Dallas Mavericks/)).toBeTruthy()
    expect(queryByText("Closest")).toBeNull()
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("wallet=")
  })

  it("with a wallet: owned/total, Complete, Closest on the fewest-to-go row, and an unlisted player is a lower bound", async () => {
    const fetchMock = vi.fn((_u: string) => res(true, body(true)))
    vi.stubGlobal("fetch", fetchMock)
    const { findByText, getByText, getAllByText } = render(
      <TeamSeriesChecklists collectionUrlSlug="nba-top-shot" teamSlug="dallas-mavericks" wallet="0x4cb714691dddf5a1" />,
    )
    expect(await findByText("5/6 players")).toBeTruthy()
    expect(String(fetchMock.mock.calls[0][0])).toContain("wallet=0x4cb714691dddf5a1")
    expect(getAllByText("Closest")).toHaveLength(1)
    expect(getByText("1 to go · $12.50")).toBeTruthy()
    // the unlisted player is not priced: "≥", the count named, never a bare total
    expect(getByText("3 to go · ≥ $40.00 · 1 unlisted")).toBeTruthy()
    expect(getByText(/Complete/)).toBeTruthy()
  })

  it("expanding a row lists the roster: owned, cheapest ask linked, unlisted unlinked", async () => {
    vi.stubGlobal("fetch", vi.fn(() => res(true, body(true))))
    const onOpen = vi.fn()
    const { findByText, getByText, getAllByRole } = render(
      <TeamSeriesChecklists collectionUrlSlug="nba-top-shot" teamSlug="dallas-mavericks" wallet="0x4cb714691dddf5a1" onOpenSeries={onOpen} />,
    )
    await findByText("2026-27")
    const rows = getAllByRole("button").filter(b => b.hasAttribute("aria-expanded"))
    fireEvent.click(rows[0])
    expect(rows[0].getAttribute("aria-expanded")).toBe("true")
    expect(getByText(/Owned ×2/)).toBeTruthy()
    const flagg = getByText("From $12.50 ASK").closest("a")
    expect(flagg?.getAttribute("href")).toBe("/nba-top-shot/edition/Cooper%20Flagg-slug")
    fireEvent.click(getByText(/Show every .* edition below/))
    expect(onOpen).toHaveBeenCalledWith(9)

    fireEvent.click(rows[1])
    const unlisted = getByText("Unlisted — no fair ask")
    expect(unlisted.closest("a")).toBeNull()
  })

  it("a failed read says so — it never renders as a team with no series", async () => {
    vi.stubGlobal("fetch", vi.fn(() => res(false, { error: "boom" })))
    const { findByText } = render(<TeamSeriesChecklists collectionUrlSlug="nba-top-shot" teamSlug="x" wallet={null} />)
    expect(await findByText(/temporary load failure, not an empty team/)).toBeTruthy()
  })

  it("no series (Pinnacle, or a team with no player editions) renders nothing", async () => {
    const fetchMock = vi.fn(() => res(true, { wallet_cached: null, series: [] }))
    vi.stubGlobal("fetch", fetchMock)
    const { container } = render(<TeamSeriesChecklists collectionUrlSlug="disney-pinnacle" teamSlug="star-wars" wallet={null} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(container.innerHTML).toBe("")
  })
})
