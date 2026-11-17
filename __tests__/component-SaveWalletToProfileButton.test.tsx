// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import SaveWalletToProfileButton from "@/components/collection/SaveWalletToProfileButton"
import { track } from "@/lib/telemetry/track"

// "Save to my profile" on a Candy collection tab (2026-09-25). Properties: it
// never shows to a signed-out viewer or on a failed read; it recognises a
// wallet that is already saved; it POSTs the base58 address VERBATIM (case is
// identity for Solana); a 402 cap message reaches the user.

const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
const CANDY_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return handler(String(url), init)
    }),
  )
  return calls
}

// 2026-11-16: a save is two clicks — "This is my collection", then the
// "Is <wallet> your wallet?" confirm. One click must not save a friend's wallet.
async function saveAndConfirm() {
  fireEvent.click(await screen.findByText("This is my collection"))
  fireEvent.click(await screen.findByText(/Yes, it.s mine/))
}

const mount = (wallet = CANDY, dbChain: string | null = "solana") =>
  render(<SaveWalletToProfileButton wallet={wallet} collectionUuid={CANDY_UUID} dbChain={dbChain} />)

// 2026-10-24: a Flow wallet searched on a Flow collection tab is saved the
// dashboard's way (all Flow collections at once), never per collection.
describe("SaveWalletToProfileButton — flow-associate", () => {
  it("posts the address to resolve-and-associate, not saved-wallets", async () => {
    const calls = stubFetch((_url, init) => (init?.method === "POST" ? json({ ok: true }) : json({ wallets: [] })))
    render(<SaveWalletToProfileButton wallet="0xBD94CADE097E50AC" collectionUuid="95f28a17-224a-4025-96ad-adf8a4c63bfd" dbChain="flow" via="flow-associate" />)
    await saveAndConfirm()
    expect(await screen.findByText(/Saved to profile/)).toBeTruthy()
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(post.url).toBe("/api/profile/resolve-and-associate")
    expect(JSON.parse(String(post.init!.body))).toEqual({ address: "0xbd94cade097e50ac" })
  })
  it("the first click only asks — nothing is POSTed until 'Yes, it's mine'", async () => {
    vi.mocked(track).mockClear()
    const calls = stubFetch((_url, init) => (init?.method === "POST" ? json({ ok: true }) : json({ wallets: [] })))
    render(<SaveWalletToProfileButton wallet="0xbd94cade097e50ac" label="@friend" collectionUuid="95f28a17-224a-4025-96ad-adf8a4c63bfd" dbChain="flow" via="flow-associate" />)
    fireEvent.click(await screen.findByText("This is my collection"))
    expect(await screen.findByText("Is @friend your wallet?")).toBeTruthy()
    expect(calls.filter((c) => c.init?.method === "POST")).toEqual([])
    fireEvent.click(screen.getByText("Cancel"))
    expect(await screen.findByText("This is my collection")).toBeTruthy()
    // measured: the confirm reports shown → cancel from the binder
    const steps = vi.mocked(track).mock.calls.filter((c) => c[0] === "own-wallet-confirm").map((c) => (c[1] as { step: string; surface: string }))
    expect(steps).toEqual([{ step: "shown", surface: "binder" }, { step: "cancel", surface: "binder" }])
    expect(calls.filter((c) => c.init?.method === "POST")).toEqual([])
  })
  it("shows the route's error text when the save is refused", async () => {
    stubFetch((_url, init) => (init?.method === "POST" ? json({ error: "Wallet limit reached" }, 402) : json({ wallets: [] })))
    render(<SaveWalletToProfileButton wallet="0xbd94cade097e50ac" collectionUuid="95f28a17-224a-4025-96ad-adf8a4c63bfd" dbChain="flow" via="flow-associate" />)
    await saveAndConfirm()
    expect(await screen.findByText("Wallet limit reached")).toBeTruthy()
  })
})

describe("SaveWalletToProfileButton", () => {
  it("renders nothing for a signed-out viewer (401)", async () => {
    const calls = stubFetch(() => json({ error: "Authentication required" }, 401))
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    expect(container.textContent).toBe("")
  })

  // 2026-10-14: signed-out is known from /api/profile/me (never 401s), so the
  // session-gated route is not called at all — it logged a red 401 in the
  // console on every anonymous wallet lookup.
  it("signed out per /api/profile/me: renders nothing and never calls the gated route", async () => {
    const calls = stubFetch((url) => (url.startsWith("/api/profile/me") ? json({ user: null }) : json({ wallets: [] })))
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.map((c) => c.url).filter((u) => u.includes("saved-wallets"))).toEqual([])
    expect(container.textContent).toBe("")
  })

  it("renders nothing and fetches nothing for an address of the wrong chain", () => {
    const calls = stubFetch(() => json({ wallets: [] }))
    const { container } = mount("0xbd94cade097e50ac", "solana")
    expect(container.textContent).toBe("")
    expect(calls).toHaveLength(0)
  })

  it("says 'Saved' when the wallet is already on the profile", async () => {
    stubFetch(() => json({ wallets: [{ wallet_addr: CANDY }] }))
    mount()
    expect(await screen.findByText(/Saved to profile/)).toBeTruthy()
  })

  it("a different-case base58 wallet is NOT treated as already saved", async () => {
    stubFetch(() => json({ wallets: [{ wallet_addr: CANDY.slice(0, -1) + "k" }] }))
    mount()
    expect(await screen.findByText("This is my collection")).toBeTruthy()
  })

  it("posts the base58 address verbatim and flips to Saved", async () => {
    const calls = stubFetch((_url, init) => (init?.method === "POST" ? json({ wallet: {} }) : json({ wallets: [] })))
    mount()
    await saveAndConfirm()
    expect(await screen.findByText(/Saved to profile/)).toBeTruthy()
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(JSON.parse(String(post.init!.body))).toEqual({ walletAddr: CANDY, collectionId: CANDY_UUID })
  })

  it("shows the cap message when the save is refused", async () => {
    stubFetch((_url, init) =>
      init?.method === "POST"
        ? json({ error: "plan_limit_reached", message: "Free plan supports 5 saved wallets and linked usernames." }, 402)
        : json({ wallets: [] }),
    )
    mount()
    await saveAndConfirm()
    expect(await screen.findByText(/Free plan supports 5/)).toBeTruthy()
  })
})
