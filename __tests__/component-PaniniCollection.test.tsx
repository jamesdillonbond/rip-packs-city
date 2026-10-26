// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

vi.mock("@/components/MomentMedia", () => ({ default: () => null }))
vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniCollection from "@/components/collection/PaniniCollection"

const NOT_WALKED = { walk: null, cardsHeld: 0, editions: 0, cataloguedCards: 0, listedNow: 0, specialSerials: 0, fmvHeldUsd: null, fmvPricedCards: 0, cards: [] }
const WALK = { lastWalkAt: "2026-09-27T20:00:00Z", lastCompleteAt: "2026-09-27T20:00:00Z", profileState: "public", reportedTotal: 2, cardsCollected: 2, unopenedPacks: 12, lastError: null }
function walked(over: Record<string, unknown> = {}, walkOver: Record<string, unknown> = {}) {
  return {
    walk: { ...WALK, ...walkOver }, cardsHeld: 2, editions: 2, cataloguedCards: 1, listedNow: 0, specialSerials: 0, fmvHeldUsd: 650, fmvPricedCards: 1,
    cards: [
      { sku: "packcard-1__1_10", editionKey: "packcard-1", serial: 1, mintCap: 10, isListed: false, askUsd: null, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: [], playerName: "Lionel Messi", setName: "Base Prizms Gold", tier: null, thumbnailUrl: null, fmvUsd: 650, catalogued: true, sport: "Soccer" },
      { sku: "packcard-9__4_99", editionKey: "packcard-9", serial: 4, mintCap: 99, isListed: false, askUsd: null, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: [], playerName: "Damian Lillard", setName: "NBA Base", tier: null, thumbnailUrl: null, fmvUsd: null, catalogued: false, sport: "Basketball" },
    ],
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}) {
  return {
    username: "adlcards", cardsSeen: 3, listedNow: 2, editions: 3, specialSerials: 1, fmvSeenUsd: 700, fmvPricedCards: 2,
    lastSeenAt: "2026-09-27T17:00:00Z",
    cards: [{ sku: "a", editionKey: "packcard-1", serial: 1, mintCap: 10, isListed: true, askUsd: 900, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: ["#1"], playerName: "Lionel Messi", setName: "Base Prizms Gold", tier: "LEGENDARY", thumbnailUrl: null, fmvUsd: 650, catalogued: true, sport: null }],
    profile: NOT_WALKED,
    ...over,
  }
}
const calls: string[] = []
function mockFetch(status: number, json: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { calls.push(u); return { ok: status >= 200 && status < 300, status, json: async () => json } }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); calls.length = 0; window.history.pushState({}, "", "/"); try { window.localStorage.clear() } catch {} })

async function lookUp(name: string) {
  const r = render(<PaniniCollection />)
  const input = r.container.querySelector("#panini-collection-username") as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  fireEvent.submit(r.container.querySelector("form")!)
  await waitFor(() => expect(r.container.querySelector('[aria-busy="true"]')).toBeNull())
  return r.container
}

describe("PaniniCollection", () => {
  it("says what it is — cards SEEN under a username — and how many of them FMV prices", async () => {
    mockFetch(200, payload())
    const c = await lookUp("AdlCards")
    await waitFor(() => expect(c.textContent).toContain("Cards seen"))
    expect(calls[0]).toContain("username=AdlCards")
    expect(c.textContent).toContain("2 of 3 priced")
    expect(c.textContent).toContain("1 not listed")
    expect(c.textContent).toContain("not the whole collection")
    expect(c.textContent).toContain("Link your Panini username")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
  })

  it("a username never seen reads 'hasn't seen', never '0 cards'", async () => {
    mockFetch(200, payload({ username: "jamesdillonbond", cardsSeen: 0, listedNow: 0, editions: 0, specialSerials: 0, fmvSeenUsd: null, fmvPricedCards: 0, lastSeenAt: null, cards: [] }))
    const c = await lookUp("Jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-unseen"]')).not.toBeNull())
    expect(c.textContent).toContain("hasn't seen a card under jamesdillonbond")
    expect(c.textContent).toContain("does not mean the collector holds nothing")
    // ⚠ 2026-09-28: the old copy claimed RPC learns a holder only from a LISTING — false (the walk
    // reads every serial's holder); it must not come back. The true gap is set coverage.
    expect(c.textContent).not.toMatch(/only learns a card.s holder when the card is listed/)
    // 2026-10-10: RPC walks ~90 products now, so the gap is products it doesn't walk, not "other sets".
    expect(c.textContent).toContain("Panini products RPC doesn't walk")
    expect(c.textContent).not.toContain("Cards seen")
  })

  it("a failed read renders 'couldn't load', never an empty collection", async () => {
    mockFetch(503, { error: "x" })
    const c = await lookUp("adlcards")
    await waitFor(() => expect(c.querySelector('[role="alert"]')).not.toBeNull())
    expect(c.textContent).not.toContain("hasn't seen a card")
  })

  it("a ?username= in the URL loads on arrival", async () => {
    window.history.pushState({}, "", "/panini-blockchain/collection?username=adlcards")
    mockFetch(200, payload())
    const r = render(<PaniniCollection />)
    await waitFor(() => expect(r.container.textContent).toContain("Cards seen"))
    expect((r.container.querySelector("#panini-collection-username") as HTMLInputElement).value).toBe("adlcards")
  })

  it("a walked username shows the profile's whole collection, its walk time in PT, and its unopened packs", async () => {
    mockFetch(200, payload({ username: "jamesdillonbond", cardsSeen: 0, listedNow: 0, editions: 0, specialSerials: 0, fmvSeenUsd: null, fmvPricedCards: 0, lastSeenAt: null, cards: [], profile: walked() }))
    const c = await lookUp("Jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-profile-note"]')).not.toBeNull())
    expect(c.textContent).toContain("Cards held")
    expect(c.textContent).toContain("Unopened packs12")
    expect(c.textContent).toContain("Every card on the profile was read")
    expect(c.textContent).toContain("1:00 PM PT")
    expect(c.textContent).not.toContain("hasn't seen a card")
    // The uncatalogued NBA card is unpriced — never $0 — and links nowhere.
    expect(c.textContent).toContain("Basketball · not priced by RPC")
    expect(c.textContent).not.toMatch(/FMV \$0|\$0\.00/)
    // 2026-10-10: the note's reason for an unpriced card is per-EDITION (not yet
    // walked / no sale or ask), never per-sport — a live profile showed NBA cards
    // at $28 FMV beside "RPC prices Panini's soccer cards; other sports aren't
    // covered". A planted sport-based claim reds this.
    expect(c.textContent).toContain("has no RPC price yet — a card is priced once RPC has walked its edition")
    expect(c.textContent).not.toMatch(/other sports aren.t covered|soccer cards/)
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-9"]')).toBeNull()
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
  })

  it("a partial walk says so — never presents a part as the whole", async () => {
    mockFetch(200, payload({ profile: walked({}, { lastCompleteAt: null, reportedTotal: 146, cardsCollected: 2 }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-profile-note"]')).not.toBeNull())
    expect(c.textContent).toContain("Partial read — 2 of 146 cards so far")
    expect(c.textContent).toContain("of 146 on the profile")
    expect(c.textContent).not.toContain("Every card on the profile was read")
    // RE-PINNED 2026-10-15: walks accumulate, so a partial read must never claim
    // that unread cards are "not shown"; it says a sale can lag until a complete read.
    expect(c.textContent).not.toContain("not shown")
    expect(c.textContent).toContain("a card sold since RPC last saw it can still appear")
    expect(c.textContent).toContain("none yet")
  })

  it("cards the marketplace shows under another owner are counted as left out", async () => {
    mockFetch(200, payload({ profile: walked({ cardsMovedSinceSeen: 61 }, { lastCompleteAt: null, reportedTotal: 25220 }) }))
    const c = await lookUp("scottyj111")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-profile-note"]')).not.toBeNull())
    expect(c.textContent).toContain("61 cards Panini's marketplace now shows under another owner are left out")
  })

  it("an unread pack count is 'not read yet', not 0", async () => {
    mockFetch(200, payload({ profile: walked({}, { unopenedPacks: null }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.textContent).toContain("Unopened packs"))
    expect(c.textContent).toContain("not read yet")
    expect(c.textContent).not.toContain("Unopened packs0")
  })

  it("a private profile says private — not 'holds nothing'", async () => {
    mockFetch(200, payload({ profile: walked({ cardsHeld: 0, cards: [] }, { profileState: "private" }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-profile-unreadable"]')).not.toBeNull())
    expect(c.textContent).toContain("profile as private")
    expect(c.textContent).not.toContain("Cards held")
  })

  it("a response without its profile block is 'couldn't load'", async () => {
    const noProfile: Record<string, unknown> = payload()
    delete noProfile.profile
    mockFetch(200, noProfile)
    const c = await lookUp("adlcards")
    await waitFor(() => expect(c.querySelector('[role="alert"]')).not.toBeNull())
  })
})

describe("PaniniCollection — filter, sort and export (2026-10-26)", () => {
  it("filters the loaded cards, says 'of the N loaded', and a no-match filter never reads as an empty collection", async () => {
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked({}, { lastCompleteAt: null, reportedTotal: 146 }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-browser"]')).not.toBeNull())
    // cardsHeld (2) == loaded (2) in the fixture, so no partial sentence yet.
    expect(c.querySelector('[data-testid="panini-collection-view-count"]')!.textContent).toContain("2 cards loaded")
    // Everything is loaded, so there is no separate full export to offer.
    expect(c.querySelector('[data-testid="panini-collection-export-all"]')).toBeNull()
    fireEvent.change(c.querySelector("#panini-card-search")!, { target: { value: "messi" } })
    expect(c.querySelector('[data-testid="panini-collection-view-count"]')!.textContent).toContain("1 of the 2 loaded cards match")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
    fireEvent.change(c.querySelector("#panini-card-search")!, { target: { value: "zzz" } })
    expect(c.querySelector('[data-testid="panini-collection-no-match"]')!.textContent).toBe("No loaded card matches these filters.")
    expect(c.textContent).not.toContain("hasn't seen a card")
    expect((c.querySelector('[data-testid="panini-collection-export"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it("when only the highest-FMV cards are loaded, the view says the filters and CSV cover THOSE, not the whole collection", async () => {
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked({ cardsHeld: 900 }) }))
    const c = await lookUp("spinotron")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-view-count"]')).not.toBeNull())
    expect(c.querySelector('[data-testid="panini-collection-view-count"]')!.textContent).toContain("cover the 2 highest-FMV cards loaded here, not all 900")
    expect(c.querySelector('[data-testid="panini-collection-export"]')!.textContent).toBe("Export CSV (2)")
    // 2026-10-26: the whole collection is one link away — the server export pages every card.
    const all = c.querySelector('[data-testid="panini-collection-export-all"]') as HTMLAnchorElement
    // The fixture payload is username adlcards (the response username, not the typed one).
    expect(all.getAttribute("href")).toBe("/api/panini-collection/export?username=adlcards")
    expect(all.textContent).toContain("Download all 900 cards")
  })
})

describe("PaniniCollection — controls and CSV download (2026-10-26)", () => {
  it("sport, sort, Listed and Special controls narrow the grid; Export downloads the CURRENT view", async () => {
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked({ listedNow: 1, cards: [
      { sku: "x1", editionKey: "packcard-1", serial: 1, mintCap: 10, isListed: true, askUsd: 900, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: ["#1"], playerName: "Lionel Messi", setName: "Base Prizms Gold", tier: null, thumbnailUrl: null, fmvUsd: 650, catalogued: true, sport: "Soccer" },
      { sku: "x2", editionKey: "packcard-9", serial: 4, mintCap: 99, isListed: false, askUsd: null, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: [], playerName: "Caitlin Clark", setName: "WNBA Base", tier: null, thumbnailUrl: null, fmvUsd: null, catalogued: false, sport: "Womens Basketball" },
    ] }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-browser"]')).not.toBeNull())
    const sport = c.querySelector('select[aria-label="Sport"]') as HTMLSelectElement
    expect(Array.from(sport.options).map((o) => o.value)).toEqual(["", "Soccer", "WNBA"])
    fireEvent.change(sport, { target: { value: "WNBA" } })
    expect(c.textContent).toContain("Caitlin Clark")
    expect(c.textContent).not.toContain("Lionel Messi")
    fireEvent.change(sport, { target: { value: "" } })
    fireEvent.change(c.querySelector('select[aria-label="Sort"]')!, { target: { value: "player_asc" } })
    const names = Array.from(c.querySelectorAll(".rpc-card")).map((n) => n.textContent ?? "")
    expect(names[0]).toContain("Caitlin Clark")
    const [listed, special] = Array.from(c.querySelectorAll('[data-testid="panini-collection-browser"] input[type="checkbox"]')) as HTMLInputElement[]
    fireEvent.click(listed)
    expect(c.textContent).not.toContain("Caitlin Clark")
    fireEvent.click(listed)
    fireEvent.click(special)
    expect(c.querySelector('[data-testid="panini-collection-view-count"]')!.textContent).toContain("1 of the 2 loaded cards match")

    const blobs: Blob[] = []
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { blobs.push(b); return "blob:x" }), revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    fireEvent.click(c.querySelector('[data-testid="panini-collection-export"]')!)
    expect(click).toHaveBeenCalledTimes(1)
    const text = await blobs[0].text()
    expect(text.split("\n")).toHaveLength(2) // header + the one special card in view
    expect(text).toContain('"Lionel Messi"')
    expect(text).not.toContain("Caitlin Clark")
    click.mockRestore()
  })
})

describe("PaniniCollection — collection value by day (2026-10-26)", () => {
  it("shows recorded days with priced-card coverage; a partial read says so; unpriced is never $0", async () => {
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked(), valueHistory: [
      { day: "2026-10-27", cards: 148, pricedCards: 140, fmvUsd: 280.5, walkComplete: false },
      { day: "2026-10-26", cards: 148, pricedCards: 0, fmvUsd: null, walkComplete: true },
    ] }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-value-history"]')).not.toBeNull())
    const t = c.querySelector('[data-testid="panini-value-history"]')!.textContent ?? ""
    expect(t).toContain("Oct 27, 2026")
    expect(t).toContain("$281") // the tab's usd() shows whole dollars at $100+
    expect(t).toContain("140 of 148 · partial read")
    // The day with nothing priced shows a dash, never $0.
    expect(t).toContain("Oct 26, 2026—0 of 148")
    expect(t).toContain("since Oct 26, 2026")
  })
  it("failed vs nothing recorded yet are different sentences", async () => {
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked(), valueHistory: null }))
    let c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-value-history"]')).not.toBeNull())
    expect(c.querySelector('[data-testid="panini-value-history"]')!.textContent).toContain("couldn't be loaded")
    cleanup()
    mockFetch(200, payload({ cardsSeen: 0, cards: [], profile: walked(), valueHistory: [] }))
    c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-value-history"]')).not.toBeNull())
    expect(c.querySelector('[data-testid="panini-value-history"]')!.textContent).toContain("nothing is recorded yet")
  })
})

