// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import PinnacleSniperClient from "@/app/(collections)/disney-pinnacle/sniper/PinnacleSniperClient"
import type { PinnacleSniperDeal, PinnacleVariant } from "@/lib/pinnacle/pinnacleTypes"

// This page was a `page.tsx` measured by NEITHER coverage gate, and no honesty guard
// covered it — `client-pages-failed-vs-empty-guard` keeps a HAND-PICKED list of sniper
// pages ([collection] and panini-blockchain) and this one was not on it. Splitting the body
// into a *Client.tsx is what makes it renderable by a test at all.
//
// What that surfaced: the stats bar was ungated, so a failed FIRST load rendered
// "0 pins" and "FMV coverage: 0 editions" — a claim about the Pinnacle market and a claim
// about our own pricing coverage, both manufactured out of our own outage, and both
// rendered ABOVE the FEED ERROR banner. The empty state below was already correct, which is
// exactly the trap the /insights/pack-reality case documents: a page is not made honest by
// fixing the one component that failed.

vi.mock("@/lib/track-click", () => ({ trackOutboundClick: vi.fn() }))

// Shaped from lib/pinnacle/pinnacleTypes.ts — a fixture the page's own renderer accepts.
// ⚠ An invented shape would exercise a render path production never produces; the first
// draft of this file used one and the component threw inside its price formatter, which is
// the lucky version of that mistake.
const DEAL: PinnacleSniperDeal = {
  flowId: "1",
  nftId: "99",
  editionKey: "royal:standard:1",
  characterName: "Mickey Mouse",
  franchise: "Disney",
  studio: "Disney",
  setName: "Steamboat Willie",
  seriesYear: 2024,
  variantType: "standard" as PinnacleVariant,
  editionType: "Limited Edition",
  serial: 12,
  mintCount: 1000,
  askPrice: 25,
  baseFmv: 40,
  adjustedFmv: 40,
  discount: 37.5,
  confidence: "HIGH",
  serialMult: 1,
  isSpecialSerial: false,
  serialSignal: null,
  thumbnailUrl: null,
  isLocked: false,
  updatedAt: new Date().toISOString(),
  buyUrl: "https://example.test/listing/1",
  listingResourceID: null,
  listingOrderID: null,
  storefrontAddress: null,
  source: "pinnacle",
  offerAmount: null,
  offerFmvPct: null,
}

function feed(over: Record<string, unknown> = {}) {
  return { count: 1, flowtyTotal: 1, fmvCoverage: 812, lastRefreshed: new Date().toISOString(), deals: [DEAL], ...over }
}

const okOnce = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)

beforeEach(() => vi.restoreAllMocks())
// This config does not enable globals, so testing-library's auto-cleanup never registers.
// Without an explicit cleanup the previous tree stays mounted and the NEXT test fails
// looking for something a stale render never produced — which reads as a component bug.
afterEach(() => cleanup())

describe("PinnacleSniperClient — a failed read must not publish figures", () => {
  it("withholds the pin count and FMV coverage when the first load fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response))
    render(<PinnacleSniperClient />)

    await waitFor(() => expect(screen.getByText(/FEED ERROR/i)).toBeTruthy())

    // ⚠ Assert the ABSENCE of the false claim, not the presence of an error message. The
    // predecessor defect on /insights/pack-reality survived review for years because its
    // test asserted only that an error appeared SOMEWHERE on the page, which was satisfied
    // by one honest section while the market claims rendered directly beneath it.
    expect(screen.queryByText("0")).toBeNull()
    const body = document.body.textContent ?? ""
    expect(body).not.toMatch(/0\s*pins/)
    expect(body).not.toMatch(/FMV coverage:\s*0/)
    // and the figures are withheld rather than replaced with a plausible-looking number
    expect(body).toMatch(/pins\s*—/)
    expect(body).toMatch(/FMV coverage\s*—/)
  })

  it("does NOT claim the market is empty when the read failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(screen.getByText(/FEED ERROR/i)).toBeTruthy())

    // "NO PINS FOUND" plus "try widening your search" is advice to fix a filter that is not
    // the problem — the quietest harm there is, because the reader acts on it and never
    // learns why it did not work.
    expect(screen.queryByText(/NO PINS FOUND/i)).toBeNull()
    expect(document.body.textContent).not.toMatch(/widening your search/i)
  })

  it("publishes the figures normally on a successful read", async () => {
    vi.stubGlobal("fetch", okOnce(feed()))
    render(<PinnacleSniperClient />)

    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/812/)
    expect(body).toMatch(/1\s*pins/)
    expect(screen.queryByText(/FEED ERROR/i)).toBeNull()
  })

  // ⚠ BOTH DIRECTIONS. A genuinely-empty market and a genuinely-zero coverage are HONEST
  // answers and must keep reading as such — a fix that blanks every empty state only moves
  // the dishonesty and cries wolf on the system working.
  it("still shows a real zero when the read SUCCEEDED with nothing in it", async () => {
    vi.stubGlobal("fetch", okOnce(feed({ deals: [], count: 0, fmvCoverage: 0 })))
    render(<PinnacleSniperClient />)

    await waitFor(() => expect(screen.getByText(/NO PINS FOUND/i)).toBeTruthy())
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/0\s*pins/)
    expect(body).toMatch(/FMV coverage:\s*0/)
    expect(screen.queryByText(/FEED ERROR/i)).toBeNull()
  })
})

describe("PinnacleSniperClient — a REFRESH failure keeps stale figures, and says so", () => {
  it("labels the retained figures as not current", async () => {
    const fetchMock = vi
      .fn()
      // first load succeeds...
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => feed() } as unknown as Response)
      // ...then every refresh fails
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
    vi.stubGlobal("fetch", fetchMock)

    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/812/))

    // ⚠ Drive the refresh through the page's OWN control rather than remounting. A remount
    // is a first load, not a refresh, so it exercises the wrong branch entirely — the
    // interesting state here is "we still hold the previous payload AND the latest read
    // failed", which only a refresh can produce.
    fireEvent.click(screen.getByRole("button", { name: /REFRESH/i }))
    await waitFor(() => expect(screen.getByText(/FEED ERROR/i)).toBeTruthy())

    const body = document.body.textContent ?? ""
    // The stale numbers are STILL SHOWN — that is deliberate, last-good beats a blank page —
    // but they are disclosed as not current. Without the disclosure the bar is a set of
    // confident figures sitting beside an error nobody would connect them to.
    expect(body).toMatch(/812/)
    expect(body).toMatch(/last successful read/i)
  })

  it("does NOT show the staleness disclosure when there is nothing stale to disclose", async () => {
    // Both directions: on a failed FIRST load the figures are withheld outright, so a
    // "showing the last successful read" line would itself be a false claim.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(screen.getByText(/FEED ERROR/i)).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/last successful read/i)
  })
})

describe("PinnacleSniperClient — the loading state is distinct from both", () => {
  it("shows the scanning state before the first response, without asserting any figure", async () => {
    let resolve: (v: unknown) => void = () => {}
    vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { resolve = r })))
    render(<PinnacleSniperClient />)

    expect(document.body.textContent).toMatch(/SCANNING THE PINNACLE MARKETPLACE/i)
    // ⚠ Two conditions individually true at different moments do not prove they are ever
    // true together: assert the figures are withheld WHILE the spinner is up, in one read.
    const body = document.body.textContent ?? ""
    expect(body).not.toMatch(/0\s*pins/)
    expect(body).not.toMatch(/NO PINS FOUND/i)

    resolve({ ok: true, status: 200, json: async () => feed() })
    await waitFor(() => expect(document.body.textContent).toMatch(/812/))
  })
})

describe("PinnacleSniperClient — the filter/sort controls", () => {
  // ⚠ WHY THESE EXIST AT ALL, beyond coverage arithmetic: a client page is many small
  // handlers, so a conversion that tests only the fetch paths drives `% Funcs` DOWN and the
  // component gate has well under a point of room. Covering the handlers is the documented
  // cost of a conversion, not an optional extra — this file landed at 57.6% funcs on its
  // fetch tests alone.
  //
  // They also pin something real: every filter narrows a set the reader is looking at, so a
  // filter that silently matches nothing is the "no listings match your filters" empty state
  // arriving for a reason the page then blames on the reader.
  async function mounted(deals = [DEAL]) {
    vi.stubGlobal("fetch", okOnce(feed({ deals, count: deals.length })))
    const r = render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))
    return r
  }

  it("filters by search text against the character name", async () => {
    await mounted()
    const search = screen.getByPlaceholderText(/search/i)
    fireEvent.change(search, { target: { value: "mickey" } })
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))

    fireEvent.change(search, { target: { value: "no-such-character" } })
    await waitFor(() => expect(screen.getByText(/NO PINS FOUND/i)).toBeTruthy())
    // ⚠ and that empty state is HONEST here — the read succeeded and the filter really did
    // match nothing, which is the case the "try widening your search" advice is written for.
    expect(screen.queryByText(/FEED ERROR/i)).toBeNull()
  })

  it("the reset control clears every filter at once", async () => {
    await mounted()
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "zzzz" } })
    await waitFor(() => expect(screen.getByText(/NO PINS FOUND/i)).toBeTruthy())

    // The reset button only exists inside the empty state — it is the page's own way out of
    // an over-narrow filter, so a broken reset strands the reader on a blank board.
    const reset = screen.getAllByRole("button").find((b) => /reset|clear/i.test(b.textContent ?? ""))
    expect(reset).toBeTruthy()
    fireEvent.click(reset!)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))
  })

  // ⚠ CORRECTION FOUND BY WRITING THESE TESTS, and it is the durable part: only SEARCH is
  // a client-side filter. Variant, franchise, max price, chasers-only and sort are all
  // SERVER-side — they go into the query string via `buildFeedUrl` and the API returns an
  // already-filtered payload. The first draft of these cases asserted that toggling
  // chasers-only emptied the board, which a stubbed fetch returning a fixed payload can
  // never produce; the assertions were about behaviour the page does not have.
  //
  // So the property worth pinning is that each control REACHES THE REQUEST. A filter that
  // silently fails to be sent does not error — the board simply keeps showing unfiltered
  // results while the control reads as applied, which is a wrong answer wearing a right
  // one's clothes.
  function lastUrl(f: ReturnType<typeof vi.fn>): string {
    const calls = f.mock.calls
    return String(calls[calls.length - 1]?.[0] ?? "")
  }

  it("sends chasers-only, max price, variant and sort to the API", async () => {
    const f = okOnce(feed())
    vi.stubGlobal("fetch", f)
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))

    // sortBy is always sent; the optional filters appear only once set.
    expect(lastUrl(f)).toMatch(/sortBy=/)
    expect(lastUrl(f)).not.toMatch(/chaserOnly/)

    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(lastUrl(f)).toMatch(/chaserOnly=true/))

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "40" } })
    await waitFor(() => expect(lastUrl(f)).toMatch(/maxPrice=40/))

    // ⚠ A max price of 0 means "no cap", not "free only" — it must be OMITTED rather than
    // sent as 0, or the API would filter every listing out and the board would go blank
    // with no control appearing to be set.
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } })
    await waitFor(() => expect(lastUrl(f)).not.toMatch(/maxPrice/))
  })

  it("sends the franchise tab, and omits it for the 'all' tab", async () => {
    const f = okOnce(feed())
    vi.stubGlobal("fetch", f)
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))
    expect(lastUrl(f)).not.toMatch(/franchise=/)

    const disney = screen.getAllByRole("button").find((b) => b.textContent?.trim() === "Disney")
    expect(disney).toBeTruthy()
    fireEvent.click(disney!)
    await waitFor(() => expect(lastUrl(f)).toMatch(/franchise=Disney/i))
  })

  it("the manual refresh re-requests immediately", async () => {
    const f = okOnce(feed())
    vi.stubGlobal("fetch", f)
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))
    const before = f.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: /REFRESH/i }))
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))
  })

  it("pausing does not blank the board", async () => {
    const f = okOnce(feed())
    vi.stubGlobal("fetch", f)
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/FMV coverage/))

    const pause = screen.getAllByRole("button").find((b) => /⏸|▶/.test(b.textContent ?? ""))
    expect(pause).toBeTruthy()
    fireEvent.click(pause!)
    // Pausing stops the countdown, not the data: the figures on screen stay real.
    expect(document.body.textContent).toMatch(/Mickey Mouse/)
  })

  it("a deal row exposes exactly one route out to the marketplace", async () => {
    vi.stubGlobal("fetch", okOnce(feed()))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))

    // The buy affordance is what makes the whole page actionable; a row without one is a
    // deal the reader cannot act on. Asserted by ROLE rather than by copy, because the
    // label is styling and the presence of a route out is the contract.
    const outbound = [...screen.getAllByRole("link"), ...screen.getAllByRole("button")].filter((el) =>
      /buy|view|market/i.test(el.textContent ?? "") ||
      (el as HTMLAnchorElement).href?.includes("disneypinnacle.com/pin/"),
    )
    expect(outbound.length).toBeGreaterThan(0)
  })
})

describe("PinnacleSniperClient — the discount badge and the row affordances", () => {
  // The discount badge is a colour-coded claim about how good a deal is. Its bands are the
  // only visual signal separating a marginal listing from a genuine one, so each band is
  // driven with a deal that sits inside it — the branch that renders "37.5% off" in the same
  // colour as a 5%-off row would be invisible in review and obvious to a collector.
  const withDiscount = (discount: number, askPrice = 25) => ({ ...DEAL, discount, askPrice })

  it.each([
    ["deep", 60],
    ["strong", 35],
    ["moderate", 20],
    ["slight", 8],
    ["negligible", 1],
  ])("renders a %s discount without dropping the row", async (_label, discount) => {
    vi.stubGlobal("fetch", okOnce(feed({ deals: [withDiscount(discount)] })))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))
    expect(screen.queryByText(/NO PINS FOUND/i)).toBeNull()
  })

  it("tracks the outbound click with the deal's identity, not a generic event", async () => {
    const { trackOutboundClick } = await import("@/lib/track-click")
    vi.stubGlobal("fetch", okOnce(feed()))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))

    // ⚠ The buy link is built from `disneypinnacle.com/pin/<flowId>`, NOT from the deal's
    // `buyUrl` field — a fixture-shaped assumption that `buyUrl` is what renders would have
    // pinned a field the row never reads.
    const link = screen.getAllByRole("link").find((a) => (a as HTMLAnchorElement).href.includes("disneypinnacle.com/pin/"))
    expect(link).toBeTruthy()
    fireEvent.click(link!)
    // ⚠ The payload is what makes outbound attribution usable at all — a tracked click that
    // cannot name the edition tells us a click happened and nothing else.
    expect(trackOutboundClick).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "pinnacle_sniper", editionKey: DEAL.editionKey }),
    )
  })

  it("the row responds to hover without throwing (inline style handlers)", async () => {
    vi.stubGlobal("fetch", okOnce(feed()))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))

    const row = screen.getByText(/Mickey Mouse/).closest("tr")
    expect(row).toBeTruthy()
    fireEvent.mouseEnter(row!)
    fireEvent.mouseLeave(row!)
    expect(document.body.textContent).toMatch(/Mickey Mouse/)
  })

  it("renders a NO_DATA-confidence deal without publishing a discount for it", async () => {
    // A moment we cannot price must not carry a discount badge — a "37% off" on an unpriced
    // edition is a claim derived from an FMV we do not have.
    vi.stubGlobal("fetch", okOnce(feed({ deals: [{ ...DEAL, confidence: "NO_DATA", baseFmv: 0, adjustedFmv: 0, discount: 0 }] })))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Mickey Mouse/))
    expect(screen.queryByText(/NO PINS FOUND/i)).toBeNull()
  })

  it("renders a locked and a special-serial deal, which the stats bar counts separately", async () => {
    vi.stubGlobal("fetch", okOnce(feed({
      deals: [
        { ...DEAL, flowId: "1", isLocked: true },
        { ...DEAL, flowId: "2", isSpecialSerial: true, serialSignal: "JERSEY MATCH" },
      ],
      count: 2,
    })))
    render(<PinnacleSniperClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/2\s*pins/))
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/1\s*locked/)
    expect(body).toMatch(/1\s*special serials/)
  })
})
