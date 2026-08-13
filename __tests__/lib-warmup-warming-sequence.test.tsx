// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import React from "react"

// The MOUNT-TIME WARMING SEQUENCE in lib/warmup/WarmupContext.tsx — the half its
// sibling suite (lib-warmup-context.test.tsx) deliberately left alone, and where
// nearly all of that file's uncovered branches live (37.6% branch / 73 uncovered
// before this landed, the worst ratio of any file in the primary coverage gate).
//
// ⚠ THE SIBLING'S REASONING WAS RIGHT ABOUT THE WRONG HALF, which is why this is
// a separate file rather than an edit to it. It declined to test the sequence
// because doing so "would assert the mock, not the behaviour" — true of the fetch
// ORCHESTRATION (what each response is parsed into), and this file does not go
// there. But the sequence also makes a set of DECISIONS whose consequences are
// plainly observable without inspecting a single response body:
//
//   • Does it fan out at all? (metered / slow connection, hidden tab)
//   • WHICH collection does it warm? (URL segment, else last-visited)
//   • Which surfaces exist for that collection? (packs is Top Shot + All Day only)
//
// "On a 2g connection the provider issues ZERO requests" is a behavioural claim,
// not a mock assertion — and it is the one that matters most to a real user,
// because the alternative is a background fan-out of five requests on a metered
// phone connection. Nothing tested it.
//
// The sequence is scheduled through requestIdleCallback, so every test stubs it
// to run synchronously; that is a scheduler, not the behaviour under test.

import WarmupProvider from "@/lib/warmup/WarmupContext"

const OWNER_KEY = "0xbd94cade097e50ac"

let fetchMock: ReturnType<typeof vi.fn>

/** Every URL the provider requested this test, in order. */
function requested(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]))
}

function setConnection(conn: { saveData?: boolean; effectiveType?: string } | undefined) {
  Object.defineProperty(navigator, "connection", {
    value: conn,
    configurable: true,
    writable: true,
  })
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true })
}

async function mountAt(path: string) {
  window.history.replaceState({}, "", path)
  render(
    <WarmupProvider>
      <div>child</div>
    </WarmupProvider>,
  )
  // The sequence is kicked off inside a (stubbed-synchronous) idle callback, but
  // its first task is async, so let the microtask queue drain.
  await waitFor(() => expect(true).toBe(true))
  await Promise.resolve()
}

beforeEach(() => {
  window.localStorage.clear()
  // getOwnerKey / getLastCollection read plain localStorage, so the real
  // modules are used — no mock. Mocking them here would have been wrong twice
  // over: vi.doMock cannot reach a statically-imported provider, and the keys
  // themselves ("rpc_owner_key" / "rpc_last_collection") are part of the
  // contract this suite is checking.
  window.localStorage.setItem("rpc_owner_key", OWNER_KEY)
  // requestIdleCallback is absent in jsdom; the module falls back to
  // setTimeout(fn, 1). Stub it so the sequence runs inline and deterministically.
  ;(window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback = (
    cb: () => void,
  ) => {
    cb()
    return 0
  }
  setHidden(false)
  setConnection(undefined)

  fetchMock = vi.fn(async (url: string) => {
    // Only the saved-wallets response shape is read by the branch under test
    // (it decides which per-wallet warmups fire); everything else is inert.
    if (String(url).includes("/api/profile/saved-wallets")) {
      return new Response(
        JSON.stringify({ wallets: [{ wallet_addr: "0xaaa", username: "alpha" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback
})

describe("warming sequence — whether to fan out at all", () => {
  it("warms on mount when the connection is unconstrained", async () => {
    await mountAt("/nba-top-shot/packs")
    const urls = requested()
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.some((u) => u.includes("/api/profile/saved-wallets"))).toBe(true)
  })

  it.each([
    ["Data Saver is on", { saveData: true }],
    ["the connection is slow-2g", { effectiveType: "slow-2g" }],
    ["the connection is 2g", { effectiveType: "2g" }],
  ])("issues ZERO requests when %s", async (_label, conn) => {
    // The user-facing point of the guard: no background fan-out on a metered or
    // slow connection. A request count is the honest assertion here — it needs
    // no knowledge of what any response contains.
    setConnection(conn)
    await mountAt("/nba-top-shot/packs")
    expect(requested()).toEqual([])
  })

  it("still warms on a fast connection that reports effectiveType", async () => {
    // Positive mirror. Without it, a guard that skipped on ANY reported
    // connection would satisfy every case above while disabling warming for
    // most real browsers, which do populate navigator.connection.
    setConnection({ effectiveType: "4g", saveData: false })
    await mountAt("/nba-top-shot/packs")
    expect(requested().length).toBeGreaterThan(0)
  })

  it("issues ZERO requests when the tab is hidden", async () => {
    setHidden(true)
    await mountAt("/nba-top-shot/packs")
    expect(requested()).toEqual([])
  })
})

describe("warming sequence — which collection it warms", () => {
  it("uses the collection in the URL", async () => {
    await mountAt("/nfl-all-day/sniper")
    const urls = requested().join(" ")
    expect(urls).toContain("/api/sniper-feed?collection=nfl-all-day")
    expect(urls).toContain("/api/collection-series?collection=nfl-all-day")
    expect(urls).not.toContain("collection=nba-top-shot")
  })

  it("falls back to the last-visited collection when the path has no collection segment", async () => {
    // /dashboard, /insights, / — the first segment is not a collection slug, so
    // the warmer must not hardcode Top Shot and warm the wrong surface.
    window.localStorage.setItem("rpc_last_collection", "laliga-golazos")
    await mountAt("/dashboard")
    const urls = requested().join(" ")
    expect(urls).toContain("collection=laliga-golazos")
  })

  it("ignores a first segment that merely looks like a slug", async () => {
    await mountAt("/not-a-collection/whatever")
    const urls = requested().join(" ")
    expect(urls).not.toContain("collection=not-a-collection")
  })
})

describe("warming sequence — which surfaces exist for that collection", () => {
  it.each([["nba-top-shot"], ["nfl-all-day"]])(
    "warms the packs surface for %s, which has one",
    async (slug) => {
      await mountAt(`/${slug}/collection`)
      expect(requested().join(" ")).toContain(`/api/packs?collection=${slug}`)
    },
  )

  // ⚠ UFC's registry slug is "ufc", NOT "ufc-strike" (lib/collections.ts). An
  // unrecognised segment falls back to the last-visited collection, so the wrong
  // slug here silently tests Top Shot instead — which is exactly what the
  // paired positive assertion below catches.
  it.each([["laliga-golazos"], ["disney-pinnacle"], ["ufc"]])(
    "does NOT warm packs for %s — that route 400s there",
    async (slug) => {
      // Warming a route that cannot serve this collection spends a request to
      // cache an error. The skip is the behaviour; assert it by absence.
      await mountAt(`/${slug}/collection`)
      const urls = requested().join(" ")
      expect(urls).not.toContain("/api/packs?collection=")
      // ...while the collection-wide surfaces are still warmed.
      expect(urls).toContain(`/api/sniper-feed?collection=${slug}`)
    },
  )
})

describe("warming sequence — per-wallet warmups", () => {
  it("warms wallet-search for a saved wallet, keyed on its username", async () => {
    await mountAt("/nba-top-shot/collection")
    await waitFor(() => expect(requested().some((u) => u.includes("/api/wallet-search"))).toBe(true))
  })

  it("warms the primary wallet's own collection page on the ACTIVE collection", async () => {
    // The key identity that known-issue #6 was about: warm one key, read
    // another, and every "warm" navigation is silently a cold fetch. The query
    // string here must match what the collection page itself requests.
    await mountAt("/nfl-all-day/collection")
    await waitFor(() => {
      const cm = requested().find((u) => u.includes("/api/collection-moments"))
      expect(cm).toBeTruthy()
      expect(cm).toContain("wallet=0xaaa")
      expect(cm).toContain("page=1&limit=50&sortBy=fmv_desc")
      expect(cm).toContain("collection=nfl-all-day")
    })
  })

  it("survives a failed saved-wallets read without blocking the other warmups", async () => {
    // The per-wallet block is wrapped in its own try/catch precisely so one bad
    // response cannot take the whole sequence down with it.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/profile/saved-wallets")) {
        return new Response("nope", { status: 500 })
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })
    await mountAt("/nba-top-shot/collection")
    const urls = requested().join(" ")
    expect(urls).toContain("/api/sniper-feed")
    expect(urls).toContain("/api/collection-series")
  })
})
