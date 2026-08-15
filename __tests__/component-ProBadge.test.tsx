// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// ProBadge — the Pro / Founding-member badge that sits in GlobalSiteHeader (so:
// every page of the site), /my-teams and /analytics.
//
// ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
// It was measured at 0% statements with ZERO test files referencing it, and it
// carries an 11-line comment describing a site-wide silent failure it narrowly
// avoided: keyed on `fcl.currentUser`, which is permanently signed-out since the
// 2026-08-08 wallet-connect removal, it would have rendered `null` for every Pro
// and Founding member everywhere, with `tsc` perfectly green.
//
// The fix (re-point onto `useSessionOwner`) was pinned by nothing. Verified
// 2026-08-15 by mutation: re-keying the badge onto a null identity
// (`useProStatus(null)`, one token) passed `tsc` AND the full 11,958-test suite.
// That is the repo's recurring shape — a near-miss earns a comment, not a test.
//
// ── WHAT IS PINNED, AND WHY IT IS THE WIRING ────────────────────────────────
// The assertions deliberately drive BOTH hooks through real `fetch` rather than
// mocking `useProStatus`. Mocking the hook would pin the render branches while
// leaving the identity wiring — the thing that actually broke — untested: a
// badge fed a hardcoded `{isPro:true}` renders identically whether or not it
// ever asked who the viewer is. So the load-bearing assertion is that the
// component requests /api/pro-status FOR THE WALLET THE SESSION RETURNED.
//
// ⚠ `useProStatus` holds a module-level Map cache keyed on the lowercased
// wallet with a 5-minute TTL, so every test here must use a DISTINCT wallet.
// Sharing one silently serves the previous test's answer without a fetch, which
// would make the "asks for the session's wallet" assertion vacuous.

import { ProBadge } from "@/components/auth/ProBadge"

let sessionUser: Record<string, unknown> | null
let proPayload: Record<string, unknown>
let meOk: boolean
let proOk: boolean
let calls: string[]

beforeEach(() => {
  sessionUser = { id: "u1", wallet_addr: "0xAAAA000000000001" }
  proPayload = { is_pro: true, plan: "pro", days_remaining: 30 }
  meOk = true
  proOk = true
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url)
      if (url.startsWith("/api/profile/me")) {
        return Promise.resolve({ ok: meOk, json: async () => ({ user: sessionUser }) } as Response)
      }
      if (url.startsWith("/api/pro-status")) {
        return Promise.resolve({ ok: proOk, json: async () => proPayload } as Response)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const proStatusCalls = () => calls.filter((u) => u.startsWith("/api/pro-status"))

describe("ProBadge — renders for a real member", () => {
  it("renders PRO for a Pro member", async () => {
    sessionUser = { id: "u1", wallet_addr: "0xAAAA000000000010" }
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(container.textContent).toContain("PRO"))
    expect(container.querySelector("span")?.getAttribute("title")).toBe("RPC Pro")
  })

  it("renders FOUNDING for a founding member, not PRO", async () => {
    sessionUser = { id: "u1", wallet_addr: "0xAAAA000000000011" }
    proPayload = { is_pro: true, plan: "founding", days_remaining: 900 }
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(container.textContent).toContain("FOUNDING"))
    expect(container.querySelector("span")?.getAttribute("title")).toBe("Founding Member")
  })
})

describe("ProBadge — keys on the SESSION identity (the regression that was unpinned)", () => {
  it("asks /api/pro-status for the wallet the session returned", async () => {
    const wallet = "0xAAAA000000000012"
    sessionUser = { id: "u1", wallet_addr: wallet }
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(container.textContent).toContain("PRO"))

    // ⚠ THE MUTATION TARGET. `useProStatus(null)` — or any re-keying onto an
    // identity that is not the session's — makes this list EMPTY, because the
    // hook short-circuits on a null wallet and never fetches. Asserting only on
    // the rendered badge would NOT catch it: with the badge gone the text
    // assertions above red too, but a future refactor that hardcodes a wallet,
    // or reads one from a different source, would keep them green.
    expect(
      proStatusCalls(),
      "ProBadge must look up Pro status for the signed-in session's wallet",
    ).toHaveLength(1)
    expect(proStatusCalls()[0]).toContain(encodeURIComponent(wallet.toLowerCase()))
  })

  it("never asks for Pro status when the viewer is signed out", async () => {
    sessionUser = null
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(calls.some((u) => u.startsWith("/api/profile/me"))).toBe(true))
    // An anonymous viewer must cost zero Pro lookups — the badge is display
    // state, and /api/pro-status on a null wallet would be a pointless request
    // on every public page view.
    expect(proStatusCalls()).toEqual([])
    expect(container.textContent).toBe("")
  })
})

describe("ProBadge — renders nothing rather than something wrong", () => {
  it("renders nothing for a signed-in non-member", async () => {
    sessionUser = { id: "u1", wallet_addr: "0xAAAA000000000013" }
    proPayload = { is_pro: false, plan: null, days_remaining: 0 }
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(proStatusCalls()).toHaveLength(1))
    expect(container.textContent).toBe("")
  })

  it("renders nothing when the Pro lookup fails, never a downgraded badge", async () => {
    // A failed read must not render "PRO" (claiming membership we could not
    // verify) and must not render a distinct broken state either — the honest
    // output for an unknown membership is no badge at all.
    sessionUser = { id: "u1", wallet_addr: "0xAAAA000000000014" }
    proOk = false
    proPayload = {}
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(proStatusCalls()).toHaveLength(1))
    expect(container.textContent).toBe("")
  })

  it("renders nothing when the session read fails", async () => {
    meOk = false
    const { container } = render(<ProBadge />)
    await waitFor(() => expect(calls.some((u) => u.startsWith("/api/profile/me"))).toBe(true))
    expect(proStatusCalls()).toEqual([])
    expect(container.textContent).toBe("")
  })
})
