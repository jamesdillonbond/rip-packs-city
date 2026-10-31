// @vitest-environment jsdom
//
// PlayerFollowButton (2026-10-31). Pins the four honest states: signed out -> a sign-in
// link; a FAILED status read -> "Follow unavailable" (never the Follow button); following
// / not following; and a click that POSTs and flips.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import PlayerFollowButton from "@/components/entity/PlayerFollowButton"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response)

describe("PlayerFollowButton", () => {
  it("signed out -> sign-in link back to the page", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(200, { authed: false, following: false })))
    const { container } = render(<PlayerFollowButton slug="nikola-jokic" path="/players/nikola-jokic" name="Nikola Jokić" />)
    await waitFor(() => expect(container.querySelector('[data-rpc-player-follow="anon"]')).toBeTruthy())
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/login?next=%2Fplayers%2Fnikola-jokic")
  })
  it("a failed status read renders 'unavailable', not a Follow button", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(500, { error: "x" })))
    const { container } = render(<PlayerFollowButton slug="nikola-jokic" path="/players/nikola-jokic" name="Nikola Jokić" />)
    await waitFor(() => expect(container.querySelector('[data-rpc-player-follow="unknown"]')).toBeTruthy())
    expect(container.querySelector("button")).toBeNull()
  })
  it("not following -> click POSTs and shows Following", async () => {
    const f = vi.fn((url: string, init?: RequestInit) =>
      init?.method === "POST" ? json(200, { ok: true, following: true }) : json(200, { authed: true, following: false }))
    vi.stubGlobal("fetch", f)
    const { container, getByRole } = render(<PlayerFollowButton slug="nikola-jokic" path="/players/nikola-jokic" name="Nikola Jokić" />)
    await waitFor(() => expect(container.querySelector('[data-rpc-player-follow="not-following"]')).toBeTruthy())
    fireEvent.click(getByRole("button"))
    await waitFor(() => expect(container.querySelector('[data-rpc-player-follow="following"]')).toBeTruthy())
    const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ slug: "nikola-jokic" })
  })
  it("a Pinnacle character reads 'Follow character', never 'player' (2026-10-31)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(200, { authed: true, following: false })))
    const { findByRole } = render(<PlayerFollowButton slug="goofy" collection="disney-pinnacle" path="/disney-pinnacle/player/goofy" name="Goofy" noun="character" />)
    const btn = await findByRole("button")
    expect(btn.textContent).toBe("☆ Follow character")
  })
})
