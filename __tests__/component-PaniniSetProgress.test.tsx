// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

import PaniniSetProgress from "@/components/collection/PaniniSetProgress"

function row(over: Record<string, unknown> = {}) {
  return {
    setName: "Base Prizms Gold", editionsSeen: 312, playersSeen: 312, minMintCap: 10, maxMintCap: 10, stillInPacks: 331,
    owned: 0, missing: 312, missingAsked: 300, missingUnasked: 12, costUsd: 412000, maxMissingAskUsd: 100000, ownerLastSeenAt: null,
    ...over,
  }
}

function payload(over: Record<string, unknown> = {}) {
  return {
    username: null, userSeen: null, userLastSeenAt: null,
    sets: [row()],
    coverage: { total_editions: 5101, pct_trustworthy: 35, listing_gated_editions: null, listing_gated_families: null, families: 62, edition_age_p50_h: 30, edition_age_p90_h: 47, pct_editions_stale_45d: 0 },
    coverage_error: false,
    ...over,
  }
}

const calls: string[] = []
function mockFetch(status: number, json: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url)
    return { ok: status >= 200 && status < 300, status, json: async () => json }
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  calls.length = 0
})

async function mount(): Promise<HTMLElement> {
  const { container } = render(<PaniniSetProgress />)
  await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull())
  return container
}

describe("PaniniSetProgress", () => {
  it("shows the cost split into priced + unpriced, the largest ask, and the coverage note", async () => {
    mockFetch(200, payload())
    const c = await mount()
    const text = c.textContent ?? ""
    expect(text).toContain("Base Prizms Gold")
    expect(text).toContain("$412,000")
    expect(text).toContain("for 300 + 12 unpriced")
    expect(text).toContain("$100,000")
    expect(text).toContain("Editions seen")
    expect(c.querySelector('[data-testid="panini-coverage-note"]')).not.toBeNull()
    // No username → no holder column.
    expect(text).not.toContain("Seen held")
  })

  it("a set with no confirmed ask is 'no confirmed asks', never $0", async () => {
    mockFetch(200, payload({ sets: [row({ missingAsked: 0, missingUnasked: 312, costUsd: null, maxMissingAskUsd: null })] }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("no confirmed asks")
    expect(text).not.toContain("$0")
  })

  it("a username RPC never saw says so — not '0 of 312'", async () => {
    mockFetch(200, payload({ username: "nobody", userSeen: false }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("RPC has not seen any card held by nobody")
    expect(text).not.toContain("0 of 312")
    expect(text).not.toContain("Seen held")
  })

  it("a seen username gets the holder column, dated", async () => {
    mockFetch(200, payload({ username: "adlcards", userSeen: true, userLastSeenAt: "2026-09-27T14:24:49Z", sets: [row({ owned: 310, missing: 2, missingAsked: 2, missingUnasked: 0, costUsd: 185000 })] }))
    const text = (await mount()).textContent ?? ""
    expect(text).toContain("Seen held")
    expect(text).toContain("310 of 312")
    expect(text).toContain("last seen Sep 27, 2026")
  })

  it("a failed read renders 'couldn't load', never an empty tracker", async () => {
    mockFetch(503, { error: "Set progress is unavailable right now." })
    const c = await mount()
    expect(c.querySelector('[role="alert"]')).not.toBeNull()
    expect(c.textContent).toContain("Couldn't load sets")
    expect(c.textContent).not.toContain("has not indexed any Panini sets")
  })

  it("a 400 names the username problem", async () => {
    window.history.pushState({}, "", "/panini-blockchain/sets?username=0xdeadbeefdeadbeef")
    mockFetch(400, { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -)." })
    const c = await mount()
    expect(calls[0]).toContain("username=0xdeadbeefdeadbeef")
    expect(c.textContent).toContain("doesn't look like a Panini username")
    // The URL's username is written into the field.
    expect((c.querySelector("#panini-username") as HTMLInputElement).value).toBe("0xdeadbeefdeadbeef")
    window.history.pushState({}, "", "/")
  })

  it("submitting a username re-reads with it", async () => {
    mockFetch(200, payload())
    const c = await mount()
    const input = c.querySelector("#panini-username") as HTMLInputElement
    fireEvent.change(input, { target: { value: "@AdlCards" } })
    fireEvent.submit(c.querySelector("form")!)
    await waitFor(() => expect(calls.some((u) => u.includes("username=AdlCards"))).toBe(true))
  })

  const PRODUCTS = [
    { setId: 2332, name: "2026 Panini NFT Prizm World Cup Soccer", sport: "Soccer", sets: 62, editionsSeen: 5217, owned: 0, ownerLastSeenAt: null },
    { setId: 1940, name: "2023 Panini NFT Prizm Football", sport: "Football", sets: 90, editionsSeen: 1016, owned: 4, ownerLastSeenAt: null },
    { setId: 2161, name: null, sport: "Basketball", sets: 3, editionsSeen: 40, owned: 0, ownerLastSeenAt: null },
  ]

  it("the product picker groups products by sport and names an unnamed one honestly", async () => {
    mockFetch(200, payload({ products: PRODUCTS, product: PRODUCTS[0] }))
    const c = await mount()
    const sel = c.querySelector("#panini-product") as HTMLSelectElement
    expect(sel.value).toBe("2332")
    const groups = [...sel.querySelectorAll("optgroup")].map((g) => g.label)
    expect(groups).toEqual(["Soccer", "Football", "Basketball"])
    expect(sel.textContent).toContain("Panini product 2161 (name not yet known)")
  })

  it("picking a product re-reads that product", async () => {
    mockFetch(200, payload({ products: PRODUCTS, product: PRODUCTS[0] }))
    const c = await mount()
    fireEvent.change(c.querySelector("#panini-product")!, { target: { value: "1940" } })
    await waitFor(() => expect(calls.some((u) => u.includes("product=1940"))).toBe(true))
  })

  it("a tracked collector holding nothing in this product is told so — not '0 of 62' as if they collect it", async () => {
    mockFetch(200, payload({ username: "adlcards", userSeen: true, userLastSeenAt: "2026-09-27T14:24:49Z", products: PRODUCTS, product: PRODUCTS[0] }))
    const c = await mount()
    expect(c.querySelector('[data-testid="panini-user-status"]')!.textContent).toContain("none in this product")
  })
})
