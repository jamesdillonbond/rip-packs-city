// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"

// /alerts "Pack chase watches": a failed list read never says "No pack chase
// watches yet" (a claim about the reader's own account); an unknown reading says
// "unknown", never a 0.

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }))
import PackChaseWatches from "@/components/alerts/PackChaseWatches"
import WatchChaseButton from "@/components/packs/WatchChaseButton"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const stub = (status: number, body: unknown, extra: Partial<Response> = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => Object.assign(new Response(JSON.stringify(body), { status }), extra)))

describe("PackChaseWatches", () => {
  it("failed read: says it failed, never 'no watches'", async () => {
    stub(500, { error: "x" })
    render(<PackChaseWatches />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/No pack chase watches yet/)
  })
  it("ok empty: says so", async () => {
    stub(200, { watches: [], readings_ok: true })
    render(<PackChaseWatches />)
    await waitFor(() => expect(document.body.textContent).toMatch(/No pack chase watches yet/))
  })
  it("unknown reading reads 'unknown', not 0", async () => {
    stub(200, { watches: [{ id: "w1", dist_id: "8903", title: "Rookie Year Royalty Pack", tier: "legendary", min_vs_launch: 2, armed: true, last_fired_at: null, reading: null }], readings_ok: false })
    render(<PackChaseWatches />)
    await waitFor(() => expect(document.body.textContent).toMatch(/current reading unknown/))
    expect(document.body.textContent).toMatch(/readings show as unknown/)
    expect(document.body.textContent).not.toMatch(/now 0 per 100/)
  })
})

describe("WatchChaseButton", () => {
  it("a signed-out save (proxy redirect) asks to sign in, not 'failed'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 405, ok: false, redirected: true, json: async () => ({}) })))
    render(<WatchChaseButton distId="8903" tier="legendary" tierLabel="Legendary" />)
    screen.getByText(/Alert me/).click()
    await waitFor(() => screen.getByText("Save"))
    screen.getByText("Save").click()
    await waitFor(() => expect(document.body.textContent).toMatch(/Sign in to set a pack alert/))
  })
})

describe("PackChaseWatches actions", () => {
  const W = { id: "w1", dist_id: "8903", title: "Rookie Year Royalty Pack", tier: "legendary", min_vs_launch: 2, armed: true, last_fired_at: null,
    reading: { remaining: 1, unopened: 18, per100Now: 100 / 18, per100Launch: 300 / 719, vsLaunch: 13.3, asOf: new Date().toISOString() } }
  it("renders a live reading and deletes, then reloads", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(JSON.stringify({ watches: calls.length > 2 ? [] : [W], readings_ok: true }), { status: 200 })
    }))
    render(<PackChaseWatches />)
    await waitFor(() => expect(document.body.textContent).toMatch(/now 5\.6 per 100 sealed packs \(13× launch rate\)/))
    screen.getByText("Delete").click()
    await waitFor(() => expect(calls).toContain("DELETE /api/alerts/pack-chase?id=w1"))
    await waitFor(() => expect(document.body.textContent).toMatch(/No pack chase watches yet/))
  })
  it("a failed delete says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ watches: [W], readings_ok: true }), { status: 200 })))
    render(<PackChaseWatches />)
    await waitFor(() => screen.getByText("Delete"))
    screen.getByText("Delete").click()
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't remove that watch/))
  })
  it("Try again re-reads after a failure", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ watches: [], readings_ok: true }), { status: 200 }))))
    render(<PackChaseWatches />)
    await waitFor(() => screen.getByText("Try again"))
    screen.getByText("Try again").click()
    await waitFor(() => expect(document.body.textContent).toMatch(/No pack chase watches yet/))
  })
})

describe("WatchChaseButton save + cancel", () => {
  it("posts the threshold and confirms", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal("fetch", f)
    render(<WatchChaseButton distId="8903" tier="legendary" tierLabel="Legendary" />)
    screen.getByText(/Alert me/).click()
    await waitFor(() => screen.getByLabelText("Alert threshold vs launch"))
    const sel = screen.getByLabelText("Alert threshold vs launch") as HTMLSelectElement
    const { fireEvent } = await import("@testing-library/react")
    fireEvent.change(sel, { target: { value: "5" } })
    screen.getByText("Save").click()
    await waitFor(() => expect(document.body.textContent).toMatch(/Watching/))
    expect(JSON.parse(String(f.mock.calls[0][1]!.body))).toEqual({ dist_id: "8903", tier: "legendary", min_vs_launch: 5 })
  })
  it("a server error shows its message; Cancel closes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "You can watch up to 50 packs." }), { status: 409 })))
    render(<WatchChaseButton distId="8903" tier="rare" tierLabel="Rare" />)
    screen.getByText(/Alert me/).click()
    await waitFor(() => screen.getByText("Save"))
    screen.getByText("Save").click()
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/up to 50 packs/))
    screen.getByText("Cancel").click()
    await waitFor(() => expect(screen.getByText(/Alert me/)).toBeTruthy())
  })
})
