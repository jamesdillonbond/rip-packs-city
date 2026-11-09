// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// FirstTouchCapture (2026-11-09, signup-wave P2): records the first landing in
// localStorage and, once signed in, claims it for the account exactly once.

const st = vi.hoisted(() => ({
  uid: null as string | null,
  privacy: false,
  attribution: "utm_source=x" as string | null,
}))

vi.mock("@/lib/track-funnel", () => ({
  getCampaignAttribution: () => st.attribution,
  getVisitorId: () => "vid-12345678",
  hasPrivacySignal: () => st.privacy,
}))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: { getSession: async () => ({ data: { session: st.uid ? { user: { id: st.uid } } : null } }) },
  }),
}))

import FirstTouchCapture from "@/components/FirstTouchCapture"
import { FIRST_TOUCH_KEY, FIRST_TOUCH_CLAIMED_KEY } from "@/lib/first-touch"

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  st.uid = null
  st.privacy = false
  st.attribution = "utm_source=x"
  fetchMock = vi.fn(async () => ({ status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("FirstTouchCapture", () => {
  it("records the first landing and never overwrites it on a later page", async () => {
    render(<FirstTouchCapture />)
    await flush()
    const first = JSON.parse(localStorage.getItem(FIRST_TOUCH_KEY)!)
    expect(first.a).toBe("utm_source=x")
    expect(first.v).toBe("vid-12345678")
    cleanup()
    st.attribution = "utm_source=later"
    render(<FirstTouchCapture />)
    await flush()
    expect(JSON.parse(localStorage.getItem(FIRST_TOUCH_KEY)!).a).toBe("utm_source=x")
  })

  it("signed out: claims nothing", async () => {
    render(<FirstTouchCapture />)
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("signed in: POSTs the stored record once, then marks the account claimed", async () => {
    st.uid = "u1"
    render(<FirstTouchCapture />)
    await waitFor(() => expect(localStorage.getItem(FIRST_TOUCH_CLAIMED_KEY)).toBe("u1"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/profile/attribution")
    cleanup()
    render(<FirstTouchCapture />)
    await flush()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("a 5xx is NOT final — the claim retries on a later page", async () => {
    st.uid = "u1"
    fetchMock.mockImplementation(async () => ({ status: 503 }))
    render(<FirstTouchCapture />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await flush()
    expect(localStorage.getItem(FIRST_TOUCH_CLAIMED_KEY)).toBeNull()
  })

  it("a privacy signal writes nothing, drops an earlier record and claims nothing", async () => {
    localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify({ a: "", l: "/", t: new Date(0).toISOString(), v: null }))
    st.privacy = true
    st.uid = "u1"
    render(<FirstTouchCapture />)
    await flush()
    expect(localStorage.getItem(FIRST_TOUCH_KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
