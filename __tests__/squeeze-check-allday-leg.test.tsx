// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"

// /insights/squeeze-check — the NFL All Day leg (2026-10-27, Top Shot parity pass 10) and the three states behind
// an empty answer. A never-scanned wallet must never render as a bag ("— moments across — editions" over 0% bars
// was the old output); it is queued for indexing instead. A scanned-empty wallet says so with its scan date; a
// failed state read says it could not tell. A toggle never shows one collection's answer under the other's label.

import SqueezeCheckPage from "@/app/insights/squeeze-check/page"

const W = "0xbd94cade097e50ac"

function bag(collection: string, player: string) {
  return {
    wallet: W,
    collection,
    total_moments: 10,
    total_editions: 4,
    editions_with_badge_coverage: 4,
    buckets: {
      liquid: { editions: 2, moments: 5 },
      moderate: { editions: 1, moments: 2 },
      squeezed: { editions: 1, moments: 3 },
      extreme: { editions: 0, moments: 0 },
    },
    top_squeezed: [
      { player_name: player, set_name: "Base", tier: "UNCOMMON", edition_key: "1:2", circulation: 100, locked: 40, burned: 20, squeeze_pct: 60, held: 3 },
    ],
    computed_at: "2026-10-27T00:00:00Z",
  }
}

type Reply = { status?: number; body: unknown }
let routes: Record<string, () => Reply>
let calls: string[]

function install() {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push(init?.method === "POST" ? `POST ${u}` : u)
      const key = Object.keys(routes).find((k) => u.includes(k))
      const r = key ? routes[key]() : { status: 404, body: {} }
      const status = r.status ?? 200
      return { ok: status >= 200 && status < 300, status, json: async () => r.body } as Response
    }),
  )
}

beforeEach(() => {
  window.history.replaceState({}, "", "/insights/squeeze-check")
  routes = {}
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function check(wallet = W) {
  fireEvent.change(screen.getByLabelText("Flow wallet address"), { target: { value: wallet } })
  fireEvent.click(screen.getByText(/Check exposure/i))
}

describe("squeeze check — NFL All Day leg", () => {
  it("?collection=nfl-all-day reads the All Day leg and labels it", async () => {
    window.history.replaceState({}, "", `/insights/squeeze-check?wallet=${W}&collection=nfl-all-day`)
    routes = { "collection=nfl-all-day": () => ({ body: { index_state: "indexed", summary: bag("nfl_all_day", "AD Player") } }) }
    install()
    render(<SqueezeCheckPage />)
    await waitFor(() => expect(screen.getByText("AD Player")).toBeTruthy())
    expect(screen.getByText(/NFL All Day moments across/)).toBeTruthy()
    expect(screen.getByTestId("sc-collection-nfl-all-day").getAttribute("aria-pressed")).toBe("true")
    expect(calls.some((c) => c.includes("/api/public/insights/squeeze-check") && c.includes("collection=nfl-all-day"))).toBe(true)
  })

  it("the toggle re-reads the same wallet and never shows the other collection's rows", async () => {
    const release: { ad: () => void } = { ad: () => {} }
    routes = {
      "collection=nba-top-shot": () => ({ body: { index_state: "indexed", summary: bag("nba_top_shot", "TS Player") } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByText("TS Player")).toBeTruthy())

    // Hold the All Day reply: while pending, Top Shot's rows must be gone from the All Day view.
    const gate = new Promise<void>((res) => { release.ad = res })
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const base = fetchMock.getMockImplementation() as unknown as (url: string, init?: RequestInit) => Promise<Response>
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("collection=nfl-all-day")) {
        await gate
        return { ok: true, status: 200, json: async () => ({ index_state: "indexed", summary: bag("nfl_all_day", "AD Player") }) } as Response
      }
      return base(url, init)
    })
    fireEvent.click(screen.getByTestId("sc-collection-nfl-all-day"))
    expect(screen.queryByText("TS Player")).toBeNull()
    await act(async () => { release.ad() })
    await waitFor(() => expect(screen.getByText("AD Player")).toBeTruthy())
    expect(screen.queryByText("TS Player")).toBeNull()
  })

  it("a never-scanned wallet is queued for indexing — no bag, no 0 moments", async () => {
    routes = {
      "/api/public/insights/squeeze-check": () => ({ body: { index_state: "not_indexed", summary: { total_moments: null, total_editions: 0, buckets: null, top_squeezed: [] } } }),
      "/api/public/queue-wallet": () => ({ status: 202, body: { queued: true } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByTestId("sc-not-indexed")).toBeTruthy())
    expect(screen.getByText(/haven't indexed this wallet's Top Shot moments yet/)).toBeTruthy()
    expect(screen.queryByText(/moments across/)).toBeNull()
    expect(screen.queryByLabelText("Exposure buckets")).toBeNull()
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/public/queue-wallet"))).toBe(true))
    await waitFor(() => expect(screen.getByText(/Indexing has started/)).toBeTruthy())
    expect(screen.getByTestId("sc-recheck")).toBeTruthy()
  })

  it("a re-check that finds moments replaces the not-indexed state with the bag", async () => {
    let indexed = false
    routes = {
      "/api/public/insights/squeeze-check": () =>
        indexed
          ? { body: { index_state: "indexed", summary: bag("nba_top_shot", "Fresh Player") } }
          : { body: { index_state: "not_indexed", summary: { total_moments: null } } },
      "/api/public/queue-wallet": () => ({ status: 202, body: { queued: true } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByTestId("sc-recheck")).toBeTruthy())
    indexed = true
    fireEvent.click(screen.getByTestId("sc-recheck"))
    await waitFor(() => expect(screen.getByText("Fresh Player")).toBeTruthy())
    expect(screen.queryByTestId("sc-not-indexed")).toBeNull()
  })

  it("a refused queue says indexing did not start, never that it did", async () => {
    routes = {
      "/api/public/insights/squeeze-check": () => ({ body: { index_state: "not_indexed", summary: { total_moments: null } } }),
      "/api/public/queue-wallet": () => ({ status: 429, body: { queued: false, reason: "rate_limited" } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByText(/couldn't start indexing just now/)).toBeTruthy())
    expect(screen.queryByText(/Indexing has started/)).toBeNull()
  })

  // 10-27 review: the queue state was keyed on the wallet alone, so toggling collections inherited the other
  // collection's "failed" (or out-of-rechecks "queued") state without trying.
  it("toggling to the other collection queues that collection afresh — never inherits a failed queue", async () => {
    let queueCalls = 0
    routes = {
      "/api/public/insights/squeeze-check": () => ({ body: { index_state: "not_indexed", summary: { total_moments: null } } }),
      "/api/public/queue-wallet": () => (++queueCalls === 1 ? { status: 429, body: { queued: false } } : { body: { queued: true } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByText(/couldn't start indexing just now/)).toBeTruthy())
    fireEvent.click(screen.getByTestId("sc-collection-nfl-all-day"))
    await waitFor(() => expect(calls.filter((c) => c.startsWith("POST") && c.includes("/api/public/queue-wallet"))).toHaveLength(2))
    await waitFor(() => expect(screen.queryByText(/couldn't start indexing just now/)).toBeNull())
  })

  // 10-27 review: an empty walk and a failed collection borrow both return [], so the copy states what OUR SCAN
  // found, never what the wallet holds.
  it("a scanned-empty wallet says our scan found none — not 'not indexed', and never that the wallet holds none", async () => {
    routes = {
      "/api/public/insights/squeeze-check": () => ({ body: { index_state: "empty", last_scanned_at: "2026-10-27T17:00:00Z", summary: { total_moments: null } } }),
    }
    install()
    render(<SqueezeCheckPage />)
    fireEvent.click(screen.getByTestId("sc-collection-nfl-all-day"))
    await check()
    await waitFor(() => expect(screen.getByTestId("sc-empty")).toBeTruthy())
    expect(screen.getByTestId("sc-empty").textContent).toMatch(/found\s+no NFL All Day moments/)
    expect(screen.queryByText(/held no/)).toBeNull()
    expect(screen.getByText(/Oct 27, 2026/)).toBeTruthy()
    expect(calls.some((c) => c.startsWith("POST /api/public/queue-wallet"))).toBe(false)
  })

  it("a failed state read says it could not tell — never empty, never a bag", async () => {
    routes = {
      "/api/public/insights/squeeze-check": () => ({ body: { index_state: "unknown", summary: { total_moments: null } } }),
    }
    install()
    render(<SqueezeCheckPage />)
    await check()
    await waitFor(() => expect(screen.getByTestId("sc-unknown")).toBeTruthy())
    expect(screen.queryByTestId("sc-empty")).toBeNull()
    expect(screen.queryByText(/held no/)).toBeNull()
    expect(screen.queryByText(/found\s+no/)).toBeNull()
    expect(screen.queryByText(/moments across/)).toBeNull()
  })
})
