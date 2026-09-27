// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

vi.mock("@/components/MomentMedia", () => ({ default: () => null }))
vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import PaniniCollection from "@/components/collection/PaniniCollection"

function payload(over: Record<string, unknown> = {}) {
  return {
    username: "adlcards", cardsSeen: 3, listedNow: 2, editions: 3, specialSerials: 1, fmvSeenUsd: 700, fmvPricedCards: 2,
    lastSeenAt: "2026-09-27T17:00:00Z",
    cards: [{ sku: "a", editionKey: "packcard-1", serial: 1, mintCap: 10, isListed: true, askUsd: 900, lastSaleUsd: null, lastSaleAt: null, seenAt: null, flags: ["#1"], playerName: "Lionel Messi", setName: "Base Prizms Gold", tier: "LEGENDARY", thumbnailUrl: null, fmvUsd: 650 }],
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
    expect(c.textContent).toContain("1 seen unlisted")
    expect(c.textContent).toContain("for most collectors this shows their listings")
    expect(c.querySelector('a[href="/panini-blockchain/edition/packcard-1"]')).not.toBeNull()
  })

  it("a username never seen reads 'hasn't seen', never '0 cards'", async () => {
    mockFetch(200, payload({ username: "jamesdillonbond", cardsSeen: 0, listedNow: 0, editions: 0, specialSerials: 0, fmvSeenUsd: null, fmvPricedCards: 0, lastSeenAt: null, cards: [] }))
    const c = await lookUp("Jamesdillonbond")
    await waitFor(() => expect(c.querySelector('[data-testid="panini-collection-unseen"]')).not.toBeNull())
    expect(c.textContent).toContain("hasn't seen a card under jamesdillonbond")
    expect(c.textContent).toContain("does not mean the collector holds nothing")
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
})
