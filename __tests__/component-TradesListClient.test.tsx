// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"

// /trades (the list). Four states, never collapsed: loading · failed read (a
// banner with Retry, NEVER "no trades yet") · none · the list. Start a trade
// navigates to the new room; a pasted link or code opens that room.

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

import TradesListClient from "@/app/trades/TradesListClient"

type Answer = { status: number; body: unknown }
let answers: Record<string, Answer | ((init?: RequestInit) => Answer)>

function installFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? "GET"} ${url}`
    const a = answers[key]
    if (!a) throw new Error(`unexpected fetch ${key}`)
    const r = typeof a === "function" ? a(init) : a
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response
  }) as typeof fetch
}

const room = (o: Partial<Record<string, unknown>> = {}) => ({
  code: "abcdefghij",
  status: "building",
  version: 2,
  side: "a",
  counterparty_present: true,
  gives: 2,
  gets: 1,
  tx_id: null,
  updated_at: "2026-10-31T17:00:00Z",
  expires_at: "2026-11-07T17:00:00Z",
  ...o,
})

beforeEach(() => {
  push.mockReset()
  answers = {}
  installFetch()
})
afterEach(cleanup)

describe("TradesListClient", () => {
  it("renders the list from a successful read, each room from the caller's side", async () => {
    answers["GET /api/trade-room"] = { status: 200, body: { rooms: [room(), room({ code: "zzzzzzzzzz", status: "sealed", side: "b", gives: 1, gets: 2, counterparty_present: true })] } }
    render(<TradesListClient />)
    expect(screen.getByText(/Loading your trades/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Building · you give 2, get 1/)).toBeTruthy())
    expect(screen.getByText(/Sealed on chain · you give 1, get 2/)).toBeTruthy()
    expect(screen.getAllByText(/two sides/)).toHaveLength(2)
  })

  // 2026-11-06 (Trevor's own /trades): a CANCELLED one-sided room read
  // "CANCELLED · … · waiting for the other side" — a closed room is not waiting.
  it("a cancelled or expired one-sided room says nobody joined, not 'waiting for the other side'", async () => {
    answers["GET /api/trade-room"] = { status: 200, body: { rooms: [
      room({ code: "cancelled01", status: "cancelled", gives: 0, gets: 0, counterparty_present: false }),
      room({ code: "building001", status: "building", gives: 0, gets: 0, counterparty_present: false }),
    ] } }
    render(<TradesListClient />)
    await waitFor(() => expect(screen.getByText(/cancelled01/)).toBeTruthy())
    expect(screen.getByText(/cancelled01 · nobody joined/)).toBeTruthy()
    expect(screen.getByText(/building001 · waiting for the other side/)).toBeTruthy()
  })

  it("a failed read is a banner with Retry, never 'no trades yet'", async () => {
    answers["GET /api/trade-room"] = { status: 503, body: { error: "We couldn't load your trades. Try again in a moment." } }
    render(<TradesListClient />)
    await waitFor(() => expect(screen.getByText(/Couldn't load your trades/)).toBeTruthy())
    expect(screen.queryByText(/No trades yet/)).toBeNull()
    answers["GET /api/trade-room"] = { status: 200, body: { rooms: [] } }
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() => expect(screen.getByText(/No trades yet/)).toBeTruthy())
  })

  it("a 200 whose body has no rooms is also a failed read", async () => {
    answers["GET /api/trade-room"] = { status: 200, body: { nope: true } }
    render(<TradesListClient />)
    await waitFor(() => expect(screen.getByText(/had no trades in it/)).toBeTruthy())
  })

  it("Start a trade creates a room and navigates to it; a refused start shows the route's reason", async () => {
    answers["GET /api/trade-room"] = { status: 200, body: { rooms: [] } }
    answers["POST /api/trade-room"] = { status: 201, body: { room: { code: "newroom123" } } }
    render(<TradesListClient />)
    await waitFor(() => expect(screen.getByText(/No trades yet/)).toBeTruthy())
    fireEvent.click(screen.getByText("Start a trade"))
    await waitFor(() => expect(push).toHaveBeenCalledWith("/trades/newroom123"))
    answers["POST /api/trade-room"] = { status: 429, body: { error: "You have 20 trades in progress. Cancel or finish one first.", code: "too_many_rooms" } }
    fireEvent.click(screen.getByText("Start a trade"))
    await waitFor(() => expect(screen.getByText(/20 trades in progress/)).toBeTruthy())
    // a created room without a code is reported, never navigated to
    answers["POST /api/trade-room"] = { status: 201, body: { room: {} } }
    fireEvent.click(screen.getByText("Start a trade"))
    await waitFor(() => expect(screen.getByText(/its link was missing/)).toBeTruthy())
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("Open takes a full link or a bare code, and refuses anything else", async () => {
    answers["GET /api/trade-room"] = { status: 200, body: { rooms: [] } }
    render(<TradesListClient />)
    await waitFor(() => expect(screen.getByText(/No trades yet/)).toBeTruthy())
    const input = screen.getByLabelText("Trade link or code") as HTMLInputElement
    fireEvent.change(input, { target: { value: "https://www.rippackscity.com/trades/ABCDEFGHIJ" } })
    fireEvent.click(screen.getByText("Open"))
    expect(push).toHaveBeenCalledWith("/trades/abcdefghij")
    fireEvent.change(input, { target: { value: "nope" } })
    fireEvent.click(screen.getByText("Open"))
    expect(screen.getByText(/Paste a trade link or its 10-character code/)).toBeTruthy()
  })
})
