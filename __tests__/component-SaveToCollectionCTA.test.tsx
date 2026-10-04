// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// SaveToCollectionCTA — the signed-in-only "Save to my collection" island on
// /share/<wallet> (2026-10-04). Contract: anonymous viewers see NOTHING (the
// public share card is the funnel wedge and must not change); a signed-in viewer
// gets one button that saves through the SAME endpoints the dashboard uses; a
// wallet already on the account says so instead; a failed save never says
// anything about the wallet.
// ─────────────────────────────────────────────────────────────────────────────

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: async () => ({ data: { user: auth.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}))

import SaveToCollectionCTA from "@/app/share/[wallet]/SaveToCollectionCTA"

const FLOW = "0xBA14E24D976F8484" // mixed case on purpose: must be saved normalized
type Call = { url: string; init?: RequestInit }
let calls: Call[]
let savedWallets: Array<{ wallet_addr: string }>
let savedListStatus: number
let postStatus: number

beforeEach(() => {
  auth.user = null
  calls = []
  savedWallets = []
  savedListStatus = 200
  postStatus = 200
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === "/api/profile/saved-wallets" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({ wallets: savedWallets }), { status: savedListStatus })
    }
    return new Response(JSON.stringify({ walletAddress: "0xba14e24d976f8484", associatedCollections: [] }), { status: postStatus })
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SaveToCollectionCTA", () => {
  it("renders NOTHING for an anonymous viewer and makes no account read", async () => {
    const { container } = render(<SaveToCollectionCTA wallet={FLOW} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe("")
    expect(calls).toHaveLength(0)
  })

  it("signed in: one click saves a Flow wallet via resolve-and-associate with the NORMALIZED address", async () => {
    auth.user = { id: "u1" }
    const { findByRole, findByText } = render(<SaveToCollectionCTA wallet={FLOW} />)
    fireEvent.click(await findByRole("button", { name: "Save to my collection" }))
    await findByText(/Saved — indexing your moments/)
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(post.url).toBe("/api/profile/resolve-and-associate")
    expect(JSON.parse(String(post.init!.body))).toEqual({ address: "0xba14e24d976f8484" })
  })

  it("a wallet already on the account says so and offers the dashboard, not a second save", async () => {
    auth.user = { id: "u1" }
    savedWallets = [{ wallet_addr: "0xba14e24d976f8484" }]
    const { findByText, queryByRole } = render(<SaveToCollectionCTA wallet={FLOW} />)
    expect((await findByText(/In your collection/)).closest("a")?.getAttribute("href")).toBe("/dashboard")
    expect(queryByRole("button")).toBeNull()
  })

  it("a FAILED saved-wallets read still offers the save (never claims 'already saved')", async () => {
    auth.user = { id: "u1" }
    savedListStatus = 500
    const { findByRole, queryByText } = render(<SaveToCollectionCTA wallet={FLOW} />)
    expect(await findByRole("button", { name: "Save to my collection" })).toBeTruthy()
    expect(queryByText(/In your collection/)).toBeNull()
  })

  it("a failed save blames the save, never the wallet", async () => {
    auth.user = { id: "u1" }
    postStatus = 503
    const { findByRole } = render(<SaveToCollectionCTA wallet={FLOW} />)
    fireEvent.click(await findByRole("button", { name: "Save to my collection" }))
    const alert = await findByRole("alert")
    expect(alert.textContent).toMatch(/Couldn.t save just now/)
    expect(alert.textContent).toMatch(/says nothing about the wallet/)
    expect(alert.textContent).not.toMatch(/no moments|empty|not found|invalid/i)
  })

  it("a lapsed session (401) asks to sign in again instead of reporting a failure", async () => {
    auth.user = { id: "u1" }
    postStatus = 401
    const { findByRole, findByText } = render(<SaveToCollectionCTA wallet={FLOW} />)
    fireEvent.click(await findByRole("button", { name: "Save to my collection" }))
    expect((await findByText("Sign in again")).getAttribute("href")).toBe("/login")
  })

  it("a username-shaped value gets no save button (the share route only carries addresses)", async () => {
    auth.user = { id: "u1" }
    const { container } = render(<SaveToCollectionCTA wallet="foryoufrank_91" />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("button")).toBeNull()
  })
})
