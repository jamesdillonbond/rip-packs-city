// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// FollowButton — the entry point that makes the (previously caller-less)
// follows backend reachable. Probes GET /api/profile/follows?username= on
// mount and renders one of loading / anon / self(null) / following /
// not-following, toggling via POST/DELETE.
//
// The behaviours worth pinning here are the honest-failure ones: a failed or
// unparseable probe must fall back to the inert sign-in CTA rather than to a
// Follow button that would 500 on click, and an optimistic toggle must roll
// back when the write fails — otherwise the UI claims a follow that the DB
// does not have.

import FollowButton from "@/components/profile/FollowButton"

let probe: any
let writeOk: boolean
let writeStatus: number
let calls: Array<{ url: string; method?: string }>

beforeEach(() => {
  probe = { authed: true, following: false, self: false }
  writeOk = true
  writeStatus = 200
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method })
      if (!init || init.method === undefined) {
        return Promise.resolve({ ok: true, json: async () => probe } as Response)
      }
      return Promise.resolve({ ok: writeOk, status: writeStatus, json: async () => ({}) } as Response)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const props = { username: "friend", accentColor: "#E03A2F" }

describe("FollowButton", () => {
  it("renders a sign-in link for anonymous visitors", async () => {
    probe = { authed: false, following: false }
    const { findByText, container } = render(<FollowButton {...props} />)
    expect(await findByText(/SIGN IN TO FOLLOW/)).toBeTruthy()
    // It is a link, not a button — clicking must navigate, not attempt a write.
    expect(container.querySelector("a")?.getAttribute("href")).toContain("/login?next=")
  })

  it("renders nothing on your own profile", async () => {
    probe = { authed: true, following: false, self: true }
    const { container } = render(<FollowButton {...props} />)
    await waitFor(() => expect(container.textContent).toBe(""))
  })

  it("offers FOLLOW when not following, and writes a POST on click", async () => {
    const { container, findByText } = render(<FollowButton {...props} />)
    expect(await findByText(/\+ FOLLOW/)).toBeTruthy()
    fireEvent.click(container.querySelector("button")!)
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
  })

  it("shows FOLLOWING when already following, and writes a DELETE on click", async () => {
    probe = { authed: true, following: true, self: false }
    const { container, findByText } = render(<FollowButton {...props} />)
    expect(await findByText(/FOLLOWING/)).toBeTruthy()
    fireEvent.click(container.querySelector("button")!)
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true))
  })

  it("swaps the label to UNFOLLOW on hover so the destructive action is legible", async () => {
    probe = { authed: true, following: true, self: false }
    const { container, findByText } = render(<FollowButton {...props} />)
    await findByText(/FOLLOWING/)
    fireEvent.mouseEnter(container.querySelector("button")!)
    await waitFor(() => expect(container.textContent).toContain("UNFOLLOW"))
    fireEvent.mouseLeave(container.querySelector("button")!)
    await waitFor(() => expect(container.textContent).toContain("FOLLOWING"))
  })

  it("rolls the optimistic follow back when the write fails", async () => {
    writeOk = false
    writeStatus = 500
    const { container, findByText } = render(<FollowButton {...props} />)
    await findByText(/\+ FOLLOW/)
    fireEvent.click(container.querySelector("button")!)
    // Optimism must not survive a failed write — the button returns to FOLLOW.
    await waitFor(() => expect(container.textContent).toContain("+ FOLLOW"))
  })

  it("falls back to the sign-in CTA when the write 401s mid-session", async () => {
    writeOk = false
    writeStatus = 401
    const { container, findByText } = render(<FollowButton {...props} />)
    await findByText(/\+ FOLLOW/)
    fireEvent.click(container.querySelector("button")!)
    await waitFor(() => expect(container.textContent).toContain("SIGN IN TO FOLLOW"))
  })

  it("falls back to the sign-in CTA when the probe itself fails", async () => {
    // A failed probe rendering "+ FOLLOW" would hand the user a button whose
    // click cannot succeed. The inert CTA is the honest fallback.
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))))
    const { findByText } = render(<FollowButton {...props} />)
    expect(await findByText(/SIGN IN TO FOLLOW/)).toBeTruthy()
  })

  it("probes the username it was given, url-encoded", async () => {
    render(<FollowButton {...props} username="a b" />)
    await waitFor(() => expect(calls[0]?.url).toContain("username=a%20b"))
  })
})
