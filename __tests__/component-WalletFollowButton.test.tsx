// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
vi.mock("@/lib/telemetry/track", () => ({ track: vi.fn() }))
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import WalletFollowButton from "@/components/profile/WalletFollowButton"

// Follow a wallet (2026-11-16) — the friend path, kept apart from "This is my
// collection". Properties: hidden for your OWN wallet; a failed probe reads
// "unavailable", never "+ Follow" and never a sign-in prompt; following POSTs to
// followed-wallets and NEVER to a save route.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function stub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }))
  return calls
}

describe("WalletFollowButton", () => {
  it("renders nothing for the viewer's own wallet", async () => {
    const calls = stub(() => json({ authed: true, following: false, own: true }))
    const { container } = render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    await waitFor(() => expect(calls.length).toBe(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe("")
  })
  it("a failed probe is 'unavailable' — not '+ Follow', not a sign-in link", async () => {
    stub(() => json({ error: "x" }, 503))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    expect(await screen.findByText("Follow unavailable")).toBeTruthy()
    expect(screen.queryByText("+ Follow")).toBeNull()
    expect(screen.queryByText(/sign in/i)).toBeNull()
  })
  it("signed out → a sign-in link", async () => {
    stub(() => json({ authed: false, following: false, own: false }))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    expect((await screen.findByText(/Follow \(sign in\)/)).closest("a")?.getAttribute("href")).toMatch(/^\/login\?next=/)
  })
  it("follows via followed-wallets with the normalised address, never a save route", async () => {
    const calls = stub((_u, init) => (init?.method === "POST" ? json({ ok: true }) : json({ authed: true, following: false, own: false })))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    expect(await screen.findByText("✓ Following")).toBeTruthy()
    const posts = calls.filter((c) => c.init?.method === "POST")
    expect(posts.map((p) => p.url)).toEqual(["/api/profile/followed-wallets"])
    expect(JSON.parse(String(posts[0].init!.body))).toEqual({ wallet: "0xbbbbbbbbbbbbbbbb" })
    expect(calls.some((c) => /saved-wallets|resolve-and-associate/.test(c.url))).toBe(false)
  })
  it("a failed follow snaps back and says so", async () => {
    stub((_u, init) => (init?.method === "POST" ? json({}, 500) : json({ authed: true, following: false, own: false })))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText("+ Follow")).toBeTruthy()
  })
})

describe("WalletFollowButton — refusals and unfollow", () => {
  const probe = (following: boolean) => json({ authed: true, following, own: false })
  it("unfollows via DELETE", async () => {
    const calls = stub((_u, init) => (init?.method === "DELETE" ? json({ ok: true }) : probe(true)))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" label="@friend" />)
    fireEvent.click(await screen.findByText("✓ Following"))
    expect(await screen.findByText("+ Follow")).toBeTruthy()
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(true)
  })
  it("409 own_wallet hides the button (it is yours, not a friend's)", async () => {
    stub((_u, init) => (init?.method === "POST" ? json({ error: "own_wallet" }, 409) : probe(false)))
    const { container } = render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    await waitFor(() => expect(container.textContent).toBe(""))
  })
  it("409 limit shows the server's sentence and snaps back", async () => {
    stub((_u, init) => (init?.method === "POST" ? json({ error: "limit", message: "You can follow up to 50 wallets." }, 409) : probe(false)))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    expect((await screen.findByRole("alert")).textContent).toMatch(/up to 50/)
    expect(screen.getByText("+ Follow")).toBeTruthy()
  })
  it("401 on click turns into the sign-in link", async () => {
    stub((_u, init) => (init?.method === "POST" ? json({}, 401) : probe(false)))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    expect(await screen.findByText(/Follow \(sign in\)/)).toBeTruthy()
  })
  it("a network error on click snaps back with a message", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++
      if (n === 1) return probe(false)
      throw new Error("offline")
    }))
    render(<WalletFollowButton wallet="0xBBBBBBBBBBBBBBBB" size="lg" />)
    fireEvent.click(await screen.findByText("+ Follow"))
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn.t reach RPC/)
  })
  it("renders nothing and fetches nothing for a non-address", () => {
    const calls = stub(() => probe(false))
    const { container } = render(<WalletFollowButton wallet="some_username" />)
    expect(container.textContent).toBe("")
    expect(calls).toHaveLength(0)
  })
})
