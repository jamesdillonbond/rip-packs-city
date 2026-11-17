// @vitest-environment jsdom
//
// The dashboard's unfinished-challenge card (2026-11-08). A challenge is
// complete only with all 6 pinned (Trevor, 11-08). The card claims something
// about the collector's own case, so it renders only on a successful read that
// lists an entry below 6 in a challenge that same read lists as open.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

import ChallengeProgressNudge, { unfinishedEntries, unenteredChallenges, PANINI_LINK_HREF } from "@/components/profile/ChallengeProgressNudge"

const dame = { slug: "dame-time", title: "Dame Time", rules: { player_names: ["Damian Lillard"] } }
const body = (pinned: number, challenges: unknown = [dame]) => ({
  cases: [
    { id: "a", challenge: null, slabs: [1, 2] },
    { id: "b", challenge: dame, slabs: Array.from({ length: pinned }, (_, i) => ({ slot: i + 1 })) },
  ],
  challenges,
})

function mockFetch(res: { ok: boolean; body?: unknown } | "throw") {
  globalThis.fetch = vi.fn(() =>
    res === "throw"
      ? Promise.reject(new Error("net"))
      : Promise.resolve({ ok: res.ok, json: () => Promise.resolve(res.body) } as Response),
  ) as typeof fetch
}

afterEach(() => {
  cleanup()
  trackMock.mockReset()
})

describe("unfinishedEntries", () => {
  it("lists an open-challenge entry below 6, never the main case", () => {
    expect(unfinishedEntries(body(4))).toEqual([{ slug: "dame-time", title: "Dame Time", pinned: 4, shopHref: "/players/damian-lillard", endsAt: null }])
  })
  it("a complete entry (6) is not unfinished", () => {
    expect(unfinishedEntries(body(6))).toEqual([])
  })
  it("an unknown challenge list (null) or a closed challenge says nothing", () => {
    expect(unfinishedEntries(body(4, null))).toEqual([])
    expect(unfinishedEntries(body(4, []))).toEqual([])
  })
  it("a shapeless body says nothing", () => {
    expect(unfinishedEntries(null)).toEqual([])
    expect(unfinishedEntries({ cases: "x" })).toEqual([])
  })
})

describe("unenteredChallenges (hatedjay, 2026-11-08: six Dames in his MAIN case, never entered)", () => {
  const ends = { ...dame, ends_at: "2026-11-09T08:00:00Z" }
  it("lists an open challenge with no entry, with its end", () => {
    expect(unenteredChallenges({ cases: [{ id: "a", challenge: null, slabs: [] }], challenges: [ends] })).toEqual([
      { slug: "dame-time", title: "Dame Time", endsAt: "2026-11-09T08:00:00Z" },
    ])
  })
  it("an entered challenge is not listed, complete or not", () => {
    expect(unenteredChallenges(body(2, [ends]))).toEqual([])
    expect(unenteredChallenges(body(6, [ends]))).toEqual([])
  })
  it("⛔ an unknown challenge list or a shapeless body says nothing", () => {
    expect(unenteredChallenges({ cases: [], challenges: null })).toEqual([])
    expect(unenteredChallenges(null)).toEqual([])
  })
})

describe("ChallengeProgressNudge", () => {
  it("invites a collector who has not entered, says the main case doesn't count, and points Panini holders at the username field", async () => {
    mockFetch({ ok: true, body: { cases: [{ id: "a", challenge: null, slabs: [1, 2, 3, 4, 5, 6] }], challenges: [dame] } })
    const { container } = render(<ChallengeProgressNudge />)
    await waitFor(() => expect(container.querySelector("[data-rpc-challenge-invite]")).not.toBeNull())
    expect(container.textContent).toMatch(/haven.t entered yet/)
    expect(container.textContent).toMatch(/main trophy case doesn.t count/)
    expect(container.querySelector(`a[href="${PANINI_LINK_HREF}"]`)).not.toBeNull()
    const enter = Array.from(container.querySelectorAll("a")).find((a) => /Enter Dame Time/.test(a.textContent ?? ""))
    expect(enter?.getAttribute("href")).toBe("/dashboard?tab=trophy&challenge=dame-time")
    expect(container.querySelector("[data-rpc-challenge-nudge]")).toBeNull()
  })
  it("shows how many more to pin and links to the entry with a full navigation", async () => {
    mockFetch({ ok: true, body: body(4) })
    const { container } = render(<ChallengeProgressNudge />)
    await waitFor(() => expect(container.querySelector("[data-rpc-challenge-nudge]")).not.toBeNull())
    expect(container.textContent).toMatch(/Dame Time: 4 \/ 6/)
    expect(container.textContent).toMatch(/Pin 2 more/)
    expect(container.querySelector("[data-rpc-challenge-shop]")?.getAttribute("href")).toBe("/players/damian-lillard")
    fireEvent.click(container.querySelector("[data-rpc-challenge-shop]")!)
    expect(trackMock).toHaveBeenCalledWith("challenge-nudge-shop-click", { challenge: "dame-time" })
    const a = container.querySelector('a[href^="/dashboard"]')!
    expect(a.getAttribute("href")).toBe("/dashboard?tab=trophy&challenge=dame-time")
    fireEvent.click(a)
    expect(trackMock).toHaveBeenCalledWith("challenge-nudge-click", { challenge: "dame-time" })
  })
  it("renders nothing on a failed or errored read", async () => {
    mockFetch({ ok: false })
    const a = render(<ChallengeProgressNudge />)
    mockFetch("throw")
    const b = render(<ChallengeProgressNudge />)
    await new Promise((r) => setTimeout(r, 20))
    expect(a.container.querySelector("[data-rpc-challenge-nudge]")).toBeNull()
    expect(b.container.querySelector("[data-rpc-challenge-nudge]")).toBeNull()
  })
})
