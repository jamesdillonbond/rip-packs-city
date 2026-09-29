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
    expect(c.textContent).toContain("Panini’s other sets".replace("’", "'"))
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
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-9"]')).toBeNull()
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
  })

  it("a partial walk says so — never presents a part as the whole", async () => {
    mockFetch(200, payload({ profile: walked({}, { lastCompleteAt: null, reportedTotal: 146, cardsCollected: 2 }) }))
    const c = await lookUp("jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-profile-note"]')).not.toBeNull())
    expect(c.textContent).toContain("Partial read — 2 of 146 cards")
    expect(c.textContent).toContain("of 146 on the profile")
    expect(c.textContent).not.toContain("Every card on the profile was read")
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
