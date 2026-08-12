// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"

// GlobalSearch — the site's first catalog search bar.
//
// The assertions that matter are the honesty ones: a failed search must render
// DIFFERENTLY from an empty one (otherwise a database blink tells the user
// their moment doesn't exist), and the empty state must state what is
// searchable rather than implying the catalog is complete.

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

import GlobalSearch from "@/components/search/GlobalSearch"

let response: { ok: boolean; body: any }
let urls: string[]
let resolvers: Array<() => void>

beforeEach(() => {
  push.mockReset()
  urls = []
  resolvers = []
  response = { ok: true, body: { results: [], meta: {} } }
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url)
      return Promise.resolve({ ok: response.ok, status: response.ok ? 200 : 503, json: async () => response.body } as Response)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const hit = (over: Partial<any> = {}) => ({
  kind: "player",
  label: "Damian Lillard",
  sublabel: null,
  href: "/nba-top-shot/player/damian-lillard",
  collection: "nba-top-shot",
  collectionName: "NBA Top Shot",
  thumbnailUrl: null,
  editionCount: 65,
  ...over,
})

function type(input: HTMLElement, value: string) {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
}

describe("GlobalSearch", () => {
  it("does not query the API for a query under 2 characters", async () => {
    const { container } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "a")
    await new Promise((r) => setTimeout(r, 260))
    expect(urls).toHaveLength(0)
  })

  it("renders results and navigates on click", async () => {
    response = { ok: true, body: { results: [hit()], meta: {} } }
    const { container, findByText } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "lillard")
    expect(await findByText("Damian Lillard")).toBeTruthy()
    fireEvent.click(container.querySelector('[role="option"]')!)
    await waitFor(() => expect(push).toHaveBeenCalledWith("/nba-top-shot/player/damian-lillard"))
  })

  it("shows an UNAVAILABLE message on failure — never 'no matches'", async () => {
    // The whole point: a 503 must not be indistinguishable from an empty result.
    response = { ok: false, body: {} }
    const { container, findByText } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "lillard")
    expect(await findByText(/Search is unavailable right now/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/No matches/)
  })

  it("explains what IS searchable when nothing matches", async () => {
    response = { ok: true, body: { results: [], meta: {} } }
    const { container, findByText } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "buzzer beater")
    expect(await findByText(/No matches for/)).toBeTruthy()
    // The coverage disclosure is a launch requirement, not decoration.
    expect(container.textContent).toMatch(/Moment descriptions aren/)
    expect(container.textContent).toMatch(/players, sets, teams/)
  })

  it("navigates with arrow keys and Enter", async () => {
    response = {
      ok: true,
      body: { results: [hit(), hit({ label: "Lillard Set", href: "/nba-top-shot/set/lillard-set", kind: "set" })], meta: {} },
    }
    const { container, findByText } = render(<GlobalSearch />)
    const input = container.querySelector("input")!
    type(input, "lillard")
    await findByText("Damian Lillard")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(push).toHaveBeenCalledWith("/nba-top-shot/set/lillard-set"))
  })

  it("clamps arrow navigation at both ends of the list", async () => {
    response = { ok: true, body: { results: [hit()], meta: {} } }
    const { container, findByText } = render(<GlobalSearch />)
    const input = container.querySelector("input")!
    type(input, "lillard")
    await findByText("Damian Lillard")
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    // Only one result exists, so every clamp lands on it.
    await waitFor(() => expect(push).toHaveBeenCalledWith("/nba-top-shot/player/damian-lillard"))
  })

  it("closes the panel on Escape", async () => {
    response = { ok: true, body: { results: [hit()], meta: {} } }
    const { container, findByText } = render(<GlobalSearch />)
    const input = container.querySelector("input")!
    type(input, "lillard")
    await findByText("Damian Lillard")
    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(container.querySelector('[role="option"]')).toBeNull())
  })

  it("debounces — one request per settled query, not one per keystroke", async () => {
    const { container } = render(<GlobalSearch />)
    const input = container.querySelector("input")!
    type(input, "li")
    type(input, "lil")
    type(input, "lill")
    await new Promise((r) => setTimeout(r, 300))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("q=lill")
  })

  it("url-encodes the query", async () => {
    const { container } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "trail blazers")
    await waitFor(() => expect(urls[0]).toContain("q=trail%20blazers"))
  })

  it("renders a thumbnail when the hit has one", async () => {
    response = { ok: true, body: { results: [hit({ thumbnailUrl: "https://example.test/a.png" })], meta: {} } }
    const { container, findByText } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "lillard")
    await findByText("Damian Lillard")
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/a.png")
  })

  it("labels a Pinnacle player as CHARACTER", async () => {
    response = {
      ok: true,
      body: { results: [hit({ label: "Mickey Mouse", collection: "disney-pinnacle", collectionName: "Disney Pinnacle" })], meta: {} },
    }
    const { container, findByText } = render(<GlobalSearch />)
    type(container.querySelector("input")!, "mickey")
    await findByText("Mickey Mouse")
    expect(container.textContent).toContain("CHARACTER")
  })
})
