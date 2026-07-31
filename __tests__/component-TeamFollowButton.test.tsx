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
})
