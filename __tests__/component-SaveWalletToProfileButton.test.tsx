// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import SaveWalletToProfileButton from "@/components/collection/SaveWalletToProfileButton"

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

const mount = (wallet = CANDY, dbChain: string | null = "solana") =>
  render(<SaveWalletToProfileButton wallet={wallet} collectionUuid={CANDY_UUID} dbChain={dbChain} />)

describe("SaveWalletToProfileButton", () => {
  it("renders nothing for a signed-out viewer (401)", async () => {
    const calls = stubFetch(() => json({ error: "Authentication required" }, 401))
    const { container } = mount()
    await waitFor(() => expect(calls.length).toBe(1))
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
    expect(await screen.findByText("Save to my profile")).toBeTruthy()
  })

  it("posts the base58 address verbatim and flips to Saved", async () => {
    const calls = stubFetch((_url, init) => (init?.method === "POST" ? json({ wallet: {} }) : json({ wallets: [] })))
    mount()
    fireEvent.click(await screen.findByText("Save to my profile"))
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
    fireEvent.click(await screen.findByText("Save to my profile"))
    expect(await screen.findByText(/Free plan supports 5/)).toBeTruthy()
  })
})
