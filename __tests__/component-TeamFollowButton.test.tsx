// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// TeamFollowButton (0% before this): fetches follow status on mount and renders
// one of loading / anon (sign-in link) / following / not-following, toggling via
// POST/DELETE /api/teams/follow. Drives the status state machine + the toggle.

import TeamFollowButton from "@/components/entity/TeamFollowButton"

let status: { authed: boolean; following: boolean }
beforeEach(() => {
  status = { authed: true, following: false }
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      // GET status on mount; POST/DELETE toggles just resolve ok.
      if (!init || init.method === undefined) {
        return Promise.resolve({ ok: true, json: async () => status } as Response)
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = { league: "nba", teamShortSlug: "blazers", teamPath: "/nba/team/blazers", dark: false }

describe("TeamFollowButton", () => {
  it("renders a sign-in affordance for anonymous visitors", async () => {
    status = { authed: false, following: false }
    const { findByText } = render(<TeamFollowButton {...props} />)
    expect(await findByText(/Sign in to follow/)).toBeTruthy()
  })

  it("renders a follow control for a signed-in, not-yet-following user and toggles it", async () => {
    status = { authed: true, following: false }
    const { container } = render(<TeamFollowButton {...props} />)
    // After the mount fetch resolves, a clickable control (not the sign-in link) renders.
    await waitFor(() => expect(container.querySelector("button")).toBeTruthy())
    fireEvent.click(container.querySelector("button")!)
    // The toggle issues a follow write.
    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: any[][] } }).mock.calls
      expect(calls.some((c) => c[1]?.method === "POST")).toBe(true)
    })
  })

  it("reflects an already-following state", async () => {
    status = { authed: true, following: true }
    const { container } = render(<TeamFollowButton {...props} />)
    await waitFor(() => expect(container.querySelector("button")).toBeTruthy())
  })

  it("un-follows via DELETE when already following", async () => {
    status = { authed: true, following: true }
    const { container } = render(<TeamFollowButton {...props} />)
    await waitFor(() => expect(container.querySelector("button")).toBeTruthy())
    fireEvent.click(container.querySelector("button")!)
    await waitFor(() => {
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      expect(calls.some((c) => (c[1] as RequestInit | undefined)?.method === "DELETE")).toBe(true)
    })
  })

  it("renders dark-mode variants for the anon, loading, and follow controls", async () => {
    // dark loading -> star + ellipsis with light text
    status = { authed: false, following: false }
    const anon = render(<TeamFollowButton {...props} dark />)
    expect(await anon.findByText(/Sign in to follow/)).toBeTruthy()
    anon.unmount()

    status = { authed: true, following: true }
    const following = render(<TeamFollowButton {...props} dark />)
    await waitFor(() => expect(following.container.querySelector("button")).toBeTruthy())
    // dark + following uses the light-text follow style; label reflects the state
    expect(following.container.textContent).toContain("Your")
  })

  it("drops back to the sign-in link when a toggle returns 401", async () => {
    status = { authed: true, following: false }
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          return Promise.resolve({ ok: true, json: async () => status } as Response)
        }
        // POST toggle -> session expired
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}) } as Response)
      }),
    )
    const { container, findByText } = render(<TeamFollowButton {...props} />)
    await waitFor(() => expect(container.querySelector("button")).toBeTruthy())
    fireEvent.click(container.querySelector("button")!)
    // 401 -> setState("anon") -> the sign-in affordance replaces the button.
    expect(await findByText(/Sign in to follow/)).toBeTruthy()
  })

  it("leaves the control unchanged when a toggle write fails non-401", async () => {
    status = { authed: true, following: false }
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init || init.method === undefined) {
          return Promise.resolve({ ok: true, json: async () => status } as Response)
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)
      }),
    )
    const { container } = render(<TeamFollowButton {...props} />)
    await waitFor(() => expect(container.querySelector("button")).toBeTruthy())
    fireEvent.click(container.querySelector("button")!)
    // !res.ok (500) -> early return, state stays "not-following" (still the ☆ Set label).
    await waitFor(() =>
      expect(container.querySelector("button")?.textContent).toContain("Set as my"),
    )
  })

  it("treats a failed status fetch as anonymous (GET catch branch)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))))
    const { findByText } = render(<TeamFollowButton {...props} />)
    // GET rejection -> catch -> setState("anon")
    expect(await findByText(/Sign in to follow/)).toBeTruthy()
  })

  it("treats a non-ok status fetch as not-authed (GET !r.ok branch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response)),
    )
    const { findByText } = render(<TeamFollowButton {...props} />)
    // !r.ok -> { authed:false } -> anon
    expect(await findByText(/Sign in to follow/)).toBeTruthy()
  })
})
