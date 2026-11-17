// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import FollowedWalletsList from "@/components/profile/FollowedWalletsList"

// The wallets a collector follows, at the top of Friend Activity (2026-11-16).
// THREE states: a failed read says so and never claims "you follow nobody";
// genuinely empty renders nothing; rows show @handle (else a short address) and
// can be unfollowed.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("FollowedWalletsList", () => {
  it("a failed read says it is a loading problem, nothing unfollowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)))
    render(<FollowedWalletsList />)
    expect((await screen.findByRole("status")).textContent).toMatch(/loading problem/)
  })
  it("genuinely empty renders nothing", async () => {
    const f = vi.fn(async () => json({ wallets: [] }))
    vi.stubGlobal("fetch", f)
    const { container } = render(<FollowedWalletsList />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(container.textContent).toBe("")
  })
  it("lists @handle or a short address, says they are not your collection, and unfollows", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method === "DELETE") return json({ ok: true })
      return json({ wallets: [
        { wallet_addr: "0xbbbbbbbbbbbbbbbb", username: "FriendHandle" },
        { wallet_addr: "0xcccccccccccccccc", username: null },
      ] })
    }))
    render(<FollowedWalletsList />)
    expect(await screen.findByText("@FriendHandle")).toBeTruthy()
    expect(screen.getByText("0xcccc…cccc")).toBeTruthy()
    expect(screen.getByText(/not part of your collection/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Unfollow @FriendHandle"))
    await waitFor(() => expect(screen.queryByText("@FriendHandle")).toBeNull())
    const del = calls.find((c) => c.init?.method === "DELETE")!
    expect(JSON.parse(String(del.init!.body))).toEqual({ wallet: "0xbbbbbbbbbbbbbbbb" })
  })
  it("a failed unfollow keeps the row", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? json({}, 500) : json({ wallets: [{ wallet_addr: "0xbbbbbbbbbbbbbbbb", username: "FriendHandle" }] })))
    render(<FollowedWalletsList />)
    fireEvent.click(await screen.findByLabelText("Unfollow @FriendHandle"))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText("@FriendHandle")).toBeTruthy()
  })
})
