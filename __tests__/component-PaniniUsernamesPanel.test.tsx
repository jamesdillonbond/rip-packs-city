// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import PaniniUsernamesPanel from "@/components/profile/PaniniUsernamesPanel"

// Linking a Panini username (2026-09-25). The properties: a failed list read
// says so and never renders as "none linked"; a failed summary is not "0
// cards"; the summary is labelled listing-based; the server's refusal message
// reaches the user; unlink calls DELETE.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const identity = (over: Record<string, unknown> = {}) => ({
  collection: "panini-blockchain",
  username: "moesidani",
  created_at: "2026-09-25T00:00:00Z",
  summary: { username: "moesidani", cards_seen: 7731, listed_now: 7721, special_serials: 499, editions: 2864, last_seen_at: null },
  summary_failed: false,
  ...over,
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return handler(String(url), init)
    }),
  )
  return calls
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("PaniniUsernamesPanel", () => {
  it("a failed list read says so — it is not an empty list", async () => {
    stubFetch(() => json({ error: "down" }, 503))
    render(<PaniniUsernamesPanel />)
    expect(await screen.findByText(/Couldn.t load your linked Panini usernames/)).toBeTruthy()
    expect(screen.queryByText(/cards seen/)).toBeNull()
  })

  it("renders a linked username's listing-based summary", async () => {
    stubFetch(() => json({ identities: [identity()] }))
    render(<PaniniUsernamesPanel />)
    expect(await screen.findByText("moesidani")).toBeTruthy()
    expect(screen.getByText(/7,731 cards seen/)).toBeTruthy()
    expect(screen.getByText(/listing-based, not full holdings/)).toBeTruthy()
  })

  it("a failed summary is not rendered as 0 cards", async () => {
    stubFetch(() => json({ identities: [identity({ summary: null, summary_failed: true })] }))
    render(<PaniniUsernamesPanel />)
    expect(await screen.findByText(/Couldn.t load this username.s cards/)).toBeTruthy()
    expect(screen.queryByText(/0 cards seen/)).toBeNull()
  })

  it("requires a username before posting", async () => {
    const calls = stubFetch(() => json({ identities: [] }))
    render(<PaniniUsernamesPanel />)
    await waitFor(() => expect(calls.length).toBe(1))
    fireEvent.click(screen.getByText("Link username"))
    expect(await screen.findByText("Enter your Panini username")).toBeTruthy()
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0)
  })

  it("posts the username and shows the server's refusal message", async () => {
    const calls = stubFetch((_url, init) =>
      init?.method === "POST"
        ? json({ error: "username_not_seen", message: "RPC hasn't seen any Panini cards listed under that username." }, 404)
        : json({ identities: [] }),
    )
    render(<PaniniUsernamesPanel />)
    fireEvent.change(screen.getByLabelText("Panini username"), { target: { value: "Ghost" } })
    fireEvent.click(screen.getByText("Link username"))
    expect(await screen.findByText(/hasn't seen any Panini cards/)).toBeTruthy()
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(JSON.parse(String(post.init!.body))).toEqual({ username: "Ghost" })
  })

  it("a successful link reloads the list", async () => {
    let linked = false
    stubFetch((_url, init) => {
      if (init?.method === "POST") {
        linked = true
        return json({ identity: {}, created: true })
      }
      return json({ identities: linked ? [identity()] : [] })
    })
    render(<PaniniUsernamesPanel />)
    fireEvent.change(screen.getByLabelText("Panini username"), { target: { value: "MoeSidani" } })
    fireEvent.keyDown(screen.getByLabelText("Panini username"), { key: "Enter" })
    expect(await screen.findByText("moesidani")).toBeTruthy()
  })

  it("unlink sends DELETE, and a failed unlink says so", async () => {
    const calls = stubFetch((_url, init) =>
      init?.method === "DELETE" ? json({ error: "down" }, 500) : json({ identities: [identity()] }),
    )
    render(<PaniniUsernamesPanel />)
    fireEvent.click(await screen.findByText("Unlink"))
    expect(await screen.findByText(/Couldn't unlink moesidani/)).toBeTruthy()
    const del = calls.find((c) => c.init?.method === "DELETE")!
    expect(JSON.parse(String(del.init!.body))).toEqual({ username: "moesidani" })
  })
})
