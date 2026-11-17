// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, act } from "@testing-library/react"
import TeamFollowButton from "@/components/entity/TeamFollowButton"

// 2026-10-11: a failed follow/unfollow write used to leave the button exactly as it
// was, so the click read as "nothing happened". It now says "Couldn’t update — try
// again" for 4 s. And a status body with no boolean `authed` is UNKNOWN, never
// "signed out". component-TeamFollowButton.test.tsx covers the happy paths; this file
// pins the failure paths it does not reach.

const props = { league: "NBA", teamShortSlug: "blazers", teamPath: "/nba-top-shot/team/blazers" }

function stubFetch(write: () => Promise<Response>, statusBody: unknown = { authed: true, following: false }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) =>
      !init || init.method === undefined
        ? Promise.resolve({ ok: true, json: async () => statusBody } as Response)
        : write(),
    ),
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("TeamFollowButton — a failed write is visible", () => {
  it("a 500 on the write says it failed, keeps the old state, then clears after 4 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubFetch(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response))
    const { findByText, getByRole } = render(<TeamFollowButton {...props} />)
    fireEvent.click(await findByText("☆ Set as my NBA team"))
    expect(await findByText("Couldn’t update — try again")).toBeTruthy()
    // the state did NOT flip to following on a failed write
    expect(getByRole("button").getAttribute("aria-pressed")).toBe("false")
    await act(async () => {
      vi.advanceTimersByTime(4100)
    })
    expect(getByRole("button").textContent).toBe("☆ Set as my NBA team")
  })

  it("a write that THROWS (network) says it failed too", async () => {
    stubFetch(() => Promise.reject(new Error("network down")))
    const { findByText } = render(<TeamFollowButton {...props} />)
    fireEvent.click(await findByText("☆ Set as my NBA team"))
    expect(await findByText("Couldn’t update — try again")).toBeTruthy()
  })

  it("a status body with no boolean `authed` is unknown — never 'Sign in to follow'", async () => {
    stubFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response), { following: true })
    const { findByTestId, queryByText } = render(<TeamFollowButton {...props} />)
    expect(await findByTestId("follow-status-unknown")).toBeTruthy()
    expect(queryByText(/Sign in to follow/)).toBeNull()
  })
})
