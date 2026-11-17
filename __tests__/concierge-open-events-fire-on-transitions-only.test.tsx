// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SupportChat from "@/components/SupportChat"

// R73's reach instrument (2026-10-04). The concierge widget is mounted in
// layouts that survive client-side navigation, so its props (pageContext,
// collectionId) change while the component — and its open/closed state — stays
// put. The funnel effect used to fire on EVERY run: a panel left open while the
// reader clicked through three pages logged three concierge_opened rows, and
// every navigation after a close logged another concierge_closed_without_send.
// Production showed it: one collector, 10 "opens" in 15 minutes, no closes.
//
// The property pinned here: exactly ONE event per open and ONE per close,
// however many page changes happen around them.

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: null, json: () => Promise.resolve(body) } as unknown as Response)

const count = (name: string) => trackMock.mock.calls.filter((c) => c[0] === name).length

beforeEach(() => {
  trackMock.mockClear()
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal("fetch", vi.fn(() => okJson({})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("concierge open/close funnel events fire on transitions only", () => {
  it("the initial closed render emits nothing", () => {
    render(<SupportChat pageContext="team (nba-top-shot)" collectionId="nba-top-shot" />)
    expect(count("concierge_opened")).toBe(0)
    expect(count("concierge_closed_without_send")).toBe(0)
  })

  it("navigating with the panel OPEN does not re-emit concierge_opened", async () => {
    const { getByLabelText, rerender } = render(<SupportChat pageContext="team (nba-top-shot)" collectionId="nba-top-shot" />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(getByLabelText("Close chat")).toBeTruthy())
    expect(count("concierge_opened")).toBe(1)

    // Three client-side navigations while the panel stays open.
    rerender(<SupportChat pageContext="edition (nba-top-shot)" collectionId="nba-top-shot" />)
    rerender(<SupportChat pageContext="team (nba-top-shot)" collectionId="nba-top-shot" />)
    rerender(<SupportChat pageContext="squeeze (insights)" collectionId={null} />)

    expect(count("concierge_opened")).toBe(1)
    expect(count("concierge_closed_without_send")).toBe(0)
  })

  it("navigating after a CLOSE does not re-emit concierge_closed_without_send", async () => {
    const { getByLabelText, rerender } = render(<SupportChat pageContext="team (nba-top-shot)" collectionId="nba-top-shot" />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(getByLabelText("Close chat")).toBeTruthy())
    fireEvent.click(getByLabelText("Close chat"))
    await waitFor(() => expect(count("concierge_closed_without_send")).toBe(1))

    rerender(<SupportChat pageContext="edition (nba-top-shot)" collectionId="nba-top-shot" />)
    rerender(<SupportChat pageContext="sniper (nba-top-shot)" collectionId="nba-top-shot" />)

    expect(count("concierge_closed_without_send")).toBe(1)
    expect(count("concierge_opened")).toBe(1)
  })

  it("a second real open is counted, attributed to the page it happened on", async () => {
    const { getByLabelText, rerender } = render(<SupportChat pageContext="team (nba-top-shot)" collectionId="nba-top-shot" />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(getByLabelText("Close chat")).toBeTruthy())
    fireEvent.click(getByLabelText("Close chat"))
    rerender(<SupportChat pageContext="edition (nba-top-shot)" collectionId="nba-top-shot" />)
    await waitFor(() => expect(getByLabelText("Open RPC concierge")).toBeTruthy())
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(count("concierge_opened")).toBe(2))

    const opens = trackMock.mock.calls.filter((c) => c[0] === "concierge_opened")
    expect(opens[0][1]).toMatchObject({ page: "team (nba-top-shot)" })
    expect(opens[1][1]).toMatchObject({ page: "edition (nba-top-shot)" })
  })
})
