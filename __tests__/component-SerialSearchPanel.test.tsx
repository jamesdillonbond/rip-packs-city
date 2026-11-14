// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SerialSearchPanel, { serialSearchUrl, type SerialSearchRow } from "@/components/sniper/SerialSearchPanel"

// Serial search (feedback #12359). Contracts:
//   - the coverage line ALWAYS renders on a successful read (confirmed count +
//     the "listed when last seen, not re-checked" count);
//   - unconfirmed rows live in a COLLAPSED <details>, never in the confirmed table;
//   - an empty confirmed set says "No #N confirmed listed right now", never "none listed";
//   - a failed read is a loading error, never an empty result;
//   - filters reach the request; "Back to deals" leaves serial mode.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response)
const failJson = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: "x" }) } as Response)

const row = (o: Partial<SerialSearchRow>): SerialSearchRow => ({
  nft_id: "1", listing_resource_id: null, price_usd: 5, serial_number: 23, confirmation: "confirmed_24h",
  listed_at: null, last_seen_at: new Date().toISOString(), book_verified_at: null, edition_id: "e1", external_id: "1:1",
  player_name: "P", set_name: "S", tier: "COMMON", parallel: "Standard", circulation_count: 1000, fmv_usd: 6, ...o,
})

const body = (rows: SerialSearchRow[], confirmed: number, unconfirmed: number) => ({
  serial: 23,
  coverage: { serial: 23, confirmed_count: confirmed, unconfirmed_count: unconfirmed, returned_confirmed: rows.filter((r) => r.confirmation !== "unconfirmed").length, returned_unconfirmed: rows.filter((r) => r.confirmation === "unconfirmed").length },
  rows,
})

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SerialSearchPanel", () => {
  it("renders the coverage line and keeps unconfirmed rows collapsed and separate", async () => {
    fetchMock.mockReturnValue(
      okJson(body([
        row({ nft_id: "1", player_name: "Live Guy", confirmation: "confirmed_24h" }),
        row({ nft_id: "2", player_name: "Checked Guy", confirmation: "confirmed_verified", book_verified_at: new Date().toISOString() }),
        row({ nft_id: "3", player_name: "Old Guy", confirmation: "unconfirmed", last_seen_at: "2026-10-01T00:00:00Z" }),
      ], 372, 358)),
    )
    const { getByTestId, getAllByTestId } = render(<SerialSearchPanel serial={23} maxPrice={0} tier="all" onClear={() => {}} />)
    await waitFor(() => expect(getByTestId("serial-coverage")).toBeTruthy())
    const cov = getByTestId("serial-coverage").textContent ?? ""
    expect(cov).toContain("Every #23 we can confirm is listed right now: 372")
    expect(cov).toContain("358 more were listed when last seen but not re-checked recently")
    expect(cov).toContain("they may have sold")

    const confirmedNames = getAllByTestId("serial-row").map((r) => r.textContent ?? "")
    expect(confirmedNames.some((t) => t.includes("Live Guy"))).toBe(true)
    expect(confirmedNames.some((t) => t.includes("Checked Guy"))).toBe(true)
    expect(confirmedNames.some((t) => t.includes("Old Guy"))).toBe(false)

    const details = getByTestId("serial-unconfirmed") as HTMLDetailsElement
    expect(details.tagName).toBe("DETAILS")
    expect(details.open).toBe(false)
    expect(details.textContent).toContain("Listed when last seen (not re-checked)")
    expect(getAllByTestId("serial-row-unconfirmed")[0].textContent).toContain("Old Guy")
    // View listing is outbound only
    const link = getAllByTestId("serial-row")[0].querySelector("a[target=_blank]") as HTMLAnchorElement
    expect(link.href).toContain("nbatopshot.com/moment/1")
  })

  it("an empty confirmed set says 'No #N confirmed listed right now', never 'none listed', and still renders the coverage line", async () => {
    fetchMock.mockReturnValue(okJson(body([row({ nft_id: "9", confirmation: "unconfirmed" })], 0, 4)))
    const { getByTestId, container } = render(<SerialSearchPanel serial={23} maxPrice={0} tier="all" onClear={() => {}} />)
    await waitFor(() => expect(getByTestId("serial-coverage")).toBeTruthy())
    const cov = getByTestId("serial-coverage").textContent ?? ""
    expect(cov).toContain("No #23 confirmed listed right now")
    expect(cov).toContain("4 more were listed when last seen")
    expect(container.textContent).not.toMatch(/none listed|no listings/i)
  })

  it("a genuinely empty read still renders the coverage line", async () => {
    fetchMock.mockReturnValue(okJson(body([], 0, 0)))
    const { getByTestId, queryByTestId } = render(<SerialSearchPanel serial={99} maxPrice={0} tier="all" onClear={() => {}} />)
    await waitFor(() => expect(getByTestId("serial-coverage").textContent).toContain("No #99 confirmed listed right now"))
    expect(queryByTestId("serial-unconfirmed")).toBeNull()
  })

  it("a failed read is a loading error, never an empty result", async () => {
    fetchMock.mockReturnValue(failJson())
    const { findByRole, queryByTestId } = render(<SerialSearchPanel serial={23} maxPrice={0} tier="all" onClear={() => {}} />)
    expect((await findByRole("alert")).textContent).toContain("loading error, not an empty result")
    expect(queryByTestId("serial-coverage")).toBeNull()
  })

  it("filters reach the request, and Back to deals leaves serial mode", async () => {
    fetchMock.mockReturnValue(okJson(body([], 0, 0)))
    const onClear = vi.fn()
    const { getByText, getByTestId } = render(<SerialSearchPanel serial={23} maxPrice={40} tier="rare" onClear={onClear} />)
    await waitFor(() => expect(getByTestId("serial-coverage")).toBeTruthy())
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/topshot-serial-search?serial=23&maxPrice=40&tier=rare")
    expect(getByTestId("serial-coverage").textContent).toContain("matching your filters")
    fireEvent.click(getByText("Back to deals"))
    expect(onClear).toHaveBeenCalled()
  })
})

describe("SerialSearchPanel — paging", () => {
  it("renders 100 at a time with Show more, and says when the confirmed list is the cheapest slice", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ nft_id: String(i), price_usd: i + 1, player_name: `Guy ${i}` }))
    fetchMock.mockReturnValue(okJson({ ...body(rows, 900, 0) }))
    const { getAllByTestId, getByText } = render(<SerialSearchPanel serial={1} maxPrice={0} tier="all" onClear={() => {}} />)
    await waitFor(() => expect(getAllByTestId("serial-row")).toHaveLength(100))
    expect(getByText(/Showing the 120 cheapest of 900/)).toBeTruthy()
    fireEvent.click(getByText(/Show more \(20 left\)/))
    expect(getAllByTestId("serial-row")).toHaveLength(120)
  })
})

describe("serialSearchUrl", () => {
  it("writes only the filters that are set", () => {
    expect(serialSearchUrl(23, 0, "all")).toBe("/api/topshot-serial-search?serial=23")
    expect(serialSearchUrl(1, 12.5, "legendary")).toBe("/api/topshot-serial-search?serial=1&maxPrice=12.5&tier=legendary")
  })
})
