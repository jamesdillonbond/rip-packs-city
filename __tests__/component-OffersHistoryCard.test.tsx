// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import OffersHistoryCard, { sortOpenOffers, type OpenOfferRow } from "@/components/analytics/OffersHistoryCard"

// The wallet Offers card (feedback #12361): Open | History tabs.
//   - THREE states per view: a failed read says so (never "no offers"); an
//     empty read says so; rows render;
//   - outbid (another wallet) and superseded (the wallet's own higher bid) are
//     DIFFERENT claims and render differently;
//   - a NULL floor / top bid renders "—", never $0;
//   - Open is the default only when the wallet has open offers.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response)
const failJson = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "x" }) } as Response)

const HISTORY = {
  supported: true,
  tracked_since: "2026-06-03",
  summary: { total: 3, open: 2, filled: 1, cancelled: 0 },
  rows: [
    { offer_type: "edition", amount_usd: 4, status: "filled", created_at: "2026-09-20T02:00:00Z", resolved_at: null, player_name: "Hist Player", set_name: "Base", tier: "COMMON", serial_number: null },
  ],
}

const row = (o: Partial<OpenOfferRow>): OpenOfferRow => ({
  offer_id: "x", offer_type: "edition", amount_usd: 5, created_at: "2026-11-13T00:00:00Z", edition_id: "e1", edition_external_id: "8:133",
  player_name: "P", set_name: "S", tier: "COMMON", parallel: null, serial_number: null,
  top_other_bid: null, own_higher_usd: null, floor_usd: null, floor_confirmed_at: null, serial_ask_usd: null, serial_ask_seen_at: null,
  age_days: 1, outbid: false, superseded: false, stale: false, at_or_above_floor: false, ...o,
})

const OPEN = {
  supported: true,
  summary: { open: 2, shown: 2, truncated: false, outbid: 1, superseded: 1, stale: 0, at_or_above_floor: 0 },
  rows: [
    row({ offer_id: "a", player_name: "Outbid Player", top_other_bid: 6, outbid: true, floor_usd: null }),
    row({ offer_id: "b", player_name: "Super Player", own_higher_usd: 9, superseded: true, floor_usd: 12, floor_confirmed_at: "2026-11-14T00:00:00Z" }),
  ],
}

function route(open: () => Promise<Response>, history: () => Promise<Response> = () => okJson(HISTORY)) {
  fetchMock.mockImplementation((url: string) => (String(url).includes("view=open") ? open() : history()))
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("OffersHistoryCard", () => {
  it("opens on the Open view, with outbid and superseded rendered as different claims", async () => {
    route(() => okJson(OPEN))
    const { getByText, queryByText, getAllByTestId, container } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Outbid Player")).toBeTruthy())
    expect(container.querySelector("section#offers")).toBeTruthy()
    expect(getByText(/never makes, edits or cancels/)).toBeTruthy()
    const rows = getAllByTestId("open-offer-row")
    // outbid sorts first
    expect(rows[0].textContent).toContain("Outbid Player")
    expect(rows[0].textContent).toContain("Outbid")
    expect(rows[0].textContent).not.toContain("Superseded")
    expect(rows[1].textContent).toContain("Superseded by your $9")
    // the superseded row must NOT claim it was outbid
    expect(rows[1].textContent).not.toMatch(/Outbid/)
    expect(queryByText("Hist Player")).toBeNull()
  })

  it("a NULL floor and a NULL top bid render as a dash, never $0", async () => {
    route(() => okJson(OPEN))
    const { getAllByTestId } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getAllByTestId("open-offer-row")).toHaveLength(2))
    const floors = getAllByTestId("floor").map((n) => n.textContent ?? "")
    const tops = getAllByTestId("top-bid").map((n) => n.textContent ?? "")
    expect(floors[0]).toBe("—")
    expect(tops[1]).toBe("—")
    for (const t of [...floors, ...tops]) expect(t).not.toMatch(/\$0(\.00)?$/)
  })

  it("switches between Open and History", async () => {
    route(() => okJson(OPEN))
    const { getByText, getByRole, queryByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Outbid Player")).toBeTruthy())
    fireEvent.click(getByRole("tab", { name: "History" }))
    expect(getByText("Hist Player")).toBeTruthy()
    expect(queryByText("Outbid Player")).toBeNull()
    fireEvent.click(getByRole("tab", { name: /Open/ }))
    expect(getByText("Outbid Player")).toBeTruthy()
  })

  it("defaults to History when the wallet has no open offers, and the Open view says so", async () => {
    route(() => okJson({ supported: true, summary: { open: 0, shown: 0, truncated: false, outbid: 0, superseded: 0, stale: 0, at_or_above_floor: 0 }, rows: [] }))
    const { getByText, getByRole } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Hist Player")).toBeTruthy())
    fireEvent.click(getByRole("tab", { name: /Open/ }))
    expect(getByText(/No open offers for this wallet right now/)).toBeTruthy()
  })

  it("a failed open read is a loading error, never an empty list", async () => {
    route(() => failJson())
    const { getByText, getByRole, queryByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Hist Player")).toBeTruthy())
    fireEvent.click(getByRole("tab", { name: /Open/ }))
    expect(getByText(/Couldn.t load open offers right now/)).toBeTruthy()
    expect(queryByText(/No open offers/)).toBeNull()
  })

  it("a collection without offer tracking renders nothing", async () => {
    route(() => okJson({ supported: false, rows: [], summary: null }), () => okJson({ supported: false, rows: [], summary: null }))
    const { container } = render(<OffersHistoryCard wallet="0xW" urlSlug="nfl-all-day" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector("section")).toBeNull()
  })

  it("says when the flags cover only the newest rows of a larger open set", async () => {
    route(() => okJson({ ...OPEN, summary: { ...OPEN.summary, open: 900, shown: 2, truncated: true } }))
    const { getByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText(/Flags cover your newest 2 of 900 open offers/)).toBeTruthy())
  })
})

describe("OffersHistoryCard — paging, chips, deep link", () => {
  it("renders 50 at a time with Show more, and every flag chip", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      row({ offer_id: `r${i}`, player_name: `Row ${i}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() }),
    )
    many[0] = row({ offer_id: "chips", player_name: "Chip Row", offer_type: "serial", serial_number: 23, stale: true, at_or_above_floor: true, floor_usd: 4, serial_ask_usd: 4.5, serial_ask_seen_at: "2026-11-14T00:00:00Z" })
    many[1] = row({ offer_id: "edfloor", player_name: "Floor Row", at_or_above_floor: true, floor_usd: 4, created_at: "2026-11-01T00:00:00Z" })
    route(() => okJson({ supported: true, summary: { open: 60, shown: 60, truncated: false, outbid: 0, superseded: 0, stale: 1, at_or_above_floor: 1 }, rows: many }))
    const { getAllByTestId, getByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getAllByTestId("open-offer-row")).toHaveLength(50))
    const chipRow = getAllByTestId("open-offer-row")[0].textContent ?? ""
    expect(chipRow).toContain("Chip Row")
    expect(chipRow).toContain("Stale 14d+")
    // a SERIAL offer never claims the edition floor — it names its own Moment's listing
    expect(chipRow).not.toContain("At/above floor")
    expect(chipRow).toContain("Listed at $4.50 (≤ your offer)")
    const floorRow = getAllByTestId("open-offer-row").find((r) => (r.textContent ?? "").includes("Floor Row"))!.textContent ?? ""
    expect(floorRow).toContain("At/above floor")
    expect(chipRow).toContain("#23")
    fireEvent.click(getByText(/Show more \(10 left\)/))
    expect(getAllByTestId("open-offer-row")).toHaveLength(60)
  })

  it("scrolls itself into view once when the URL asks for #offers", async () => {
    const spy = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = spy
    window.history.replaceState(null, "", "/nba-top-shot/analytics?wallet=0xW&tab=portfolio#offers")
    route(() => okJson(OPEN))
    const { getByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Outbid Player")).toBeTruthy())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    window.history.replaceState(null, "", "/")
    Element.prototype.scrollIntoView = original
  })

  it("a failed history read is a loading error, never an empty history", async () => {
    route(() => okJson({ ...OPEN, summary: { ...OPEN.summary, open: 0 }, rows: [] }), () => failJson())
    const { findByText } = render(<OffersHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    expect(await findByText(/not an empty history/)).toBeTruthy()
  })
})

describe("sortOpenOffers", () => {
  it("outbid, then at-or-above-floor, then stale, then newest", () => {
    const out = sortOpenOffers([
      row({ offer_id: "new", created_at: "2026-11-14T00:00:00Z" }),
      row({ offer_id: "stale", stale: true }),
      row({ offer_id: "floor", at_or_above_floor: true }),
      row({ offer_id: "old", created_at: "2026-11-01T00:00:00Z" }),
      row({ offer_id: "outbid", outbid: true }),
    ])
    expect(out.map((r) => r.offer_id)).toEqual(["outbid", "floor", "stale", "new", "old"])
  })
})
