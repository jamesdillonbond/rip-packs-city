// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"

// "N open Trade Block listings mention X" on a player / character page (2026-11-02).
// DECORATIVE: it may only ever state a positive count from a successful read. A failed
// read, a non-JSON body, an empty block or an unsupported collection renders NOTHING —
// never "nobody is trading this player".

import OnTheBlockLink, { onTheBlockHref } from "@/components/entity/OnTheBlockLink"
import BlockBrowseClient from "@/app/trades/block/BlockBrowseClient"

let calls: string[]
function fetchReturning(status: number, body: unknown) {
  calls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, "", "/")
})

describe("OnTheBlockLink", () => {
  it("states the count and links the filtered block", async () => {
    fetchReturning(200, { listings: [{}, {}], next_before: null })
    render(<OnTheBlockLink collection="nba-top-shot" name="Victor Wembanyama" />)
    await waitFor(() => expect(screen.getByText(/2 open Trade Block listings mention Victor Wembanyama/)).toBeTruthy())
    expect(calls[0]).toContain("collection=nba-top-shot")
    expect(calls[0]).toContain("q=Victor+Wembanyama")
    expect(screen.getByRole("link").getAttribute("href")).toBe(onTheBlockHref("nba-top-shot", "Victor Wembanyama"))
  })

  it("singular, and '+' when more pages exist", async () => {
    fetchReturning(200, { listings: [{}], next_before: null })
    render(<OnTheBlockLink collection="disney-pinnacle" name="Stitch" />)
    await waitFor(() => expect(screen.getByText(/1 open Trade Block listing mentions Stitch/)).toBeTruthy())
    cleanup()
    fetchReturning(200, { listings: [{}, {}, {}], next_before: "2026-11-02T00:00:00Z" })
    render(<OnTheBlockLink collection="nba-top-shot" name="LeBron James" />)
    await waitFor(() => expect(screen.getByText(/3\+ open Trade Block listings mention LeBron James/)).toBeTruthy())
  })

  it.each([
    ["a failed read", 503, { error: "down" }],
    ["an empty block", 200, { listings: [], next_before: null }],
    ["a body without listings", 200, { nope: true }],
  ])("%s renders nothing", async (_label, status, body) => {
    fetchReturning(status, body)
    const { container } = render(<OnTheBlockLink collection="nba-top-shot" name="Victor Wembanyama" />)
    await waitFor(() => expect(calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe("")
  })

  it("an unsupported collection makes no request and renders nothing", async () => {
    fetchReturning(200, { listings: [{}], next_before: null })
    const { container } = render(<OnTheBlockLink collection="not-a-collection" name="Someone" />)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([])
    expect(container.textContent).toBe("")
  })

  it("a thrown fetch renders nothing", async () => {
    calls = []
    globalThis.fetch = vi.fn(async () => {
      calls.push("x")
      throw new Error("offline")
    }) as typeof fetch
    const { container } = render(<OnTheBlockLink collection="nba-top-shot" name="Victor Wembanyama" />)
    await waitFor(() => expect(calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe("")
  })
})

describe("the browse page honours a deep link", () => {
  it("starts filtered by ?collection= and ?q=", async () => {
    window.history.replaceState(null, "", "/trades/block?collection=nfl-all-day&q=Josh%20Allen")
    fetchReturning(200, { listings: [], next_before: null })
    render(<BlockBrowseClient />)
    await waitFor(() => expect(screen.getByText(/No open listings match that search/)).toBeTruthy())
    expect(calls[0]).toContain("collection=nfl-all-day")
    expect(calls[0]).toContain("q=Josh+Allen")
    expect((screen.getByPlaceholderText("e.g. Wembanyama") as HTMLInputElement).value).toBe("Josh Allen")
  })
})
