// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import AdminFeedbackClient from "@/app/admin/feedback/AdminFeedbackClient"

// `admin/feedback` converted to a `*Client.tsx` so the component gate measures it.
//
// ⚠ THE CONVERSION FOUND THE SAME LIVE DEFECT AGAIN — this is now the third admin console
// in one workstream (listing-retry-queue, allow-list, feedback) whose loader returns early
// on a failure, leaving `rows` at `[]` so the list renders "No feedback in this view."
// A triage console reporting an EMPTY queue out of our own outage is the worst direction to
// be wrong in: it is the screen an operator uses to decide whether anything is broken, so a
// false "nothing reported" is read as evidence the product is healthy.
//
// Gated on `error && rows.length === 0`, not on `error` alone — a failed REFRESH keeps the
// previous rows, and last-good beats a blank queue.

vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"}>{children}</a>
  ),
}))

let storedToken: string | null = "admin-token"
vi.mock("@/lib/admin-token", () => ({
  getAdminToken: () => storedToken,
  setAdminToken: (t: string) => { storedToken = t },
  clearAdminToken: () => { storedToken = null },
}))

function json(status: number, body: unknown, ok = status < 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 12,
  created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
  updated_at: null,
  shipped_at: null,
  owner_key: null,
  user_wallet: null,
  user_email: "collector@example.test",
  page_context: "/nba-top-shot/sniper",
  feedback_type: "bug" as const,
  feedback_summary: "Sniper feed shows a stale ask",
  feedback_details: "The ask column lagged by an hour.",
  feedback_status: "new" as const,
  admin_note: null,
  duplicate_of: null,
  user_message: null,
  bot_response: null,
  session_id: null,
  ...over,
})

const STATS = {
  open_bugs: 4, open_features: 2, open_confusion: 1, open_general: 0, open_praise: 3,
  shipped_last_7d: 6, wontfix_total: 1, total_triaged: 20, total_open: 7,
}

const PAYLOAD = (over: Record<string, unknown> = {}) => ({ rows: [ROW()], stats: STATS, ...over })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  storedToken = "admin-token"
  fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => json(200, PAYLOAD()))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mountDashboard(first: () => Response = () => json(200, PAYLOAD())) {
  fetchMock.mockImplementation(async () => first())
  render(<AdminFeedbackClient />)
  await screen.findByText("Beta Feedback Triage")
}

// ─── The defect ──────────────────────────────────────────────────────────────

describe("AdminFeedbackClient — a failed read must not report an empty triage queue", () => {
  it("says the read failed instead of claiming nothing was reported", async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      // Call 1 is the auth probe (must succeed to reach the dashboard); the
      // dashboard's own row fetch is what fails.
      return calls === 1 ? json(200, { rows: [] }) : json(503, { error: "statement timeout" })
    })
    render(<AdminFeedbackClient />)
    await screen.findByText(/Couldn't load feedback/)
    expect(screen.queryByText("No feedback in this view.")).toBeNull()
  })

  it("states plainly that the absence is not evidence", async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      return calls === 1 ? json(200, { rows: [] }) : json(503, {})
    })
    render(<AdminFeedbackClient />)
    const notice = await screen.findByText(/Couldn't load feedback/)
    expect(notice.textContent).toMatch(/says nothing about what has been\s+reported/)
  })

  it("still says 'no feedback' when the read SUCCEEDS with zero rows — an honest empty must stay honest", async () => {
    await mountDashboard(() => json(200, { rows: [], stats: STATS }))
    await screen.findByText("No feedback in this view.")
    expect(screen.queryByText(/Couldn't load feedback/)).toBeNull()
  })

  it("keeps the previously-loaded rows when a REFRESH fails — last-good beats a blank queue", async () => {
    await mountDashboard()
    await screen.findByText("Sniper feed shows a stale ask")
    fetchMock.mockResolvedValue(json(503, { error: "boom" }))
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }))
    await screen.findByText("boom")
    expect(screen.getByText("Sniper feed shows a stale ask")).toBeTruthy()
    expect(screen.queryByText(/Couldn't load feedback/)).toBeNull()
  })

  it("surfaces the driver-supplied error message when the body carries one", async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      return calls === 1 ? json(200, { rows: [] }) : json(500, { error: "relation does not exist" })
    })
    render(<AdminFeedbackClient />)
    await screen.findByText("relation does not exist")
  })

  it("falls back to the status when the failure body is unparseable", async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      if (calls === 1) return json(200, { rows: [] })
      return { ok: false, status: 502, json: async () => { throw new Error("bad json") } } as unknown as Response
    })
    render(<AdminFeedbackClient />)
    await screen.findByText("HTTP 502")
  })

  it("reports a thrown fetch rather than silently showing an empty queue", async () => {
    let calls = 0
    fetchMock.mockImplementation(async () => {
      calls += 1
      if (calls === 1) return json(200, { rows: [] })
      throw new Error("network down")
    })
    render(<AdminFeedbackClient />)
    await screen.findByText("network down")
    await screen.findByText(/Couldn't load feedback/)
  })
})

// ─── Auth gate ───────────────────────────────────────────────────────────────

describe("AdminFeedbackClient — auth gate", () => {
  it("shows the sign-in gate when no token is stored and never probes", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    await screen.findByPlaceholderText("Admin token")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("probes a stored token and enters the dashboard when it is accepted", async () => {
    render(<AdminFeedbackClient />)
    await screen.findByText("Beta Feedback Triage")
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer admin-token")
  })

  it("clears a stored token the API rejects", async () => {
    fetchMock.mockResolvedValue(json(401, {}))
    render(<AdminFeedbackClient />)
    await screen.findByPlaceholderText("Admin token")
    expect(storedToken).toBeNull()
  })

  it("keeps the stored token when the PROBE fails on the network", async () => {
    // ⚠ A network failure says nothing about the token. Clearing it here would
    // make an outage look like a revoked credential and send the operator
    // hunting for a token that was fine.
    fetchMock.mockRejectedValue(new Error("offline"))
    render(<AdminFeedbackClient />)
    await screen.findByPlaceholderText("Admin token")
    expect(storedToken).toBe("admin-token")
  })

  it("refuses an empty token without calling the API", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }))
    await screen.findByText("Token required")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("reports a rejected token as invalid, not as a server failure", async () => {
    storedToken = null
    fetchMock.mockResolvedValue(json(401, {}))
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "bad" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Invalid token")
  })

  it("distinguishes a server failure from a rejected token", async () => {
    storedToken = null
    fetchMock.mockResolvedValue(json(503, {}))
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("HTTP 503")
  })

  it("surfaces a thrown probe as its message", async () => {
    storedToken = null
    fetchMock.mockRejectedValue(new Error("dns failure"))
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("dns failure")
  })

  it("falls back to a generic message when the thrown value is not an Error", async () => {
    storedToken = null
    fetchMock.mockRejectedValue("nope")
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Network error")
  })

  it("stores the accepted token and enters the dashboard", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await screen.findByText("Beta Feedback Triage")
    expect(storedToken).toBe("good")
  })

  it("trims the pasted token", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    fireEvent.change(await screen.findByPlaceholderText("Admin token"), { target: { value: "  padded " } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(storedToken).toBe("padded"))
  })

  it("submits on Enter", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    const input = await screen.findByPlaceholderText("Admin token")
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await screen.findByText("Beta Feedback Triage")
  })

  it("ignores other keys", async () => {
    storedToken = null
    render(<AdminFeedbackClient />)
    const input = await screen.findByPlaceholderText("Admin token")
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.keyDown(input, { key: "x" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a 401 mid-session drops the operator back to the gate", async () => {
    await mountDashboard()
    fetchMock.mockResolvedValue(json(401, {}))
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }))
    await waitFor(() => expect(storedToken).toBeNull())
  })
})

// ─── Stats, filters and search ───────────────────────────────────────────────

describe("AdminFeedbackClient — stats, filters and search", () => {
  it("renders the stat tiles from the payload", async () => {
    await mountDashboard()
    // `findBy`, not `getBy`: the dashboard heading renders before the row fetch
    // resolves, so the stat tiles arrive a tick later.
    expect(await screen.findByText("Open Bugs")).toBeTruthy()
    expect(screen.getByText("4")).toBeTruthy()
    expect(screen.getByText("Total Open")).toBeTruthy()
  })

  it("omits the stat tiles entirely rather than publishing zeros when stats are absent", async () => {
    // ⚠ Degrading by OMISSION is the right failure here: a "0 open bugs" tile
    // manufactured from a missing payload is a claim about the product's health.
    await mountDashboard(() => json(200, { rows: [ROW()] }))
    await screen.findByText("Sniper feed shows a stale ask")
    expect(screen.queryByText("Open Bugs")).toBeNull()
  })

  it("requests the default filter's statuses", async () => {
    await mountDashboard()
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("status=new%2Creviewed%2Cin_progress"))).toBe(true)
    })
  })

  it("adds a type filter when a typed pill is selected", async () => {
    await mountDashboard()
    fireEvent.click(screen.getByRole("button", { name: "Bugs" }))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("type=bug"))).toBe(true)
    })
  })

  it("sends no type filter for an all-status pill", async () => {
    await mountDashboard()
    fireEvent.click(screen.getByRole("button", { name: "Shipped" }))
    await waitFor(() => {
      const shipped = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("status=shipped"))
      expect(shipped.length).toBeGreaterThan(0)
      expect(shipped.every((u) => !u.includes("type="))).toBe(true)
    })
  })

  it("marks the active pill", async () => {
    await mountDashboard()
    fireEvent.click(screen.getByRole("button", { name: "Features" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Features" }).className).toContain("active"))
  })

  it("debounces the search box into the query string", async () => {
    await mountDashboard()
    fireEvent.change(screen.getByPlaceholderText(/search summary/i), { target: { value: "stale ask" } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("q=stale+ask"))).toBe(true)
    })
  })

  it("trims the query before sending it", async () => {
    await mountDashboard()
    fireEvent.change(screen.getByPlaceholderText(/search summary/i), { target: { value: "  padded  " } })
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("q=padded"))).toBe(true)
    })
  })

  it("does not fire a request per keystroke, and holds off for the debounce window", async () => {
    // ⚠ Microtask flushes CANNOT observe a timer delay — an earlier version of
    // this case awaited two resolved promises, and a mutation cutting the
    // debounce from 300ms to 0 SURVIVED it, because a `setTimeout(_, 0)` is a
    // macrotask either way. Waiting real time well inside the window is what
    // makes the delay observable at all.
    await mountDashboard()
    const before = fetchMock.mock.calls.length
    const box = screen.getByPlaceholderText(/search summary/i)
    for (const v of ["s", "st", "sta"]) fireEvent.change(box, { target: { value: v } })
    await new Promise((r) => setTimeout(r, 90))
    expect(fetchMock.mock.calls.length).toBe(before)
    // …and when it does elapse, three keystrokes cost exactly ONE request.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(urls.some((u) => u.includes("q=sta"))).toBe(true)
    })
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  it("sends no q parameter at all when the box is empty", async () => {
    await mountDashboard()
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.every((u) => !u.includes("q="))).toBe(true)
  })
})

// ─── Row cards ───────────────────────────────────────────────────────────────

describe("AdminFeedbackClient — row cards", () => {
  it("renders the summary, type badge, status and id", async () => {
    await mountDashboard()
    expect(await screen.findByText("Sniper feed shows a stale ask")).toBeTruthy()
    expect(screen.getByText("BUG")).toBeTruthy()
    expect(screen.getByText("New")).toBeTruthy()
    expect(screen.getByText("#12")).toBeTruthy()
  })

  it("falls back to the raw user message when there is no summary", async () => {
    await mountDashboard(() =>
      json(200, PAYLOAD({ rows: [ROW({ feedback_summary: null, user_message: "it just breaks" })] })),
    )
    expect(await screen.findByText("it just breaks")).toBeTruthy()
  })

  it("says so rather than rendering a blank title when neither exists", async () => {
    await mountDashboard(() =>
      json(200, PAYLOAD({ rows: [ROW({ feedback_summary: null, user_message: null })] })),
    )
    expect(await screen.findByText("(no summary)")).toBeTruthy()
  })

  it("treats an untyped row as general feedback rather than crashing on the colour map", async () => {
    await mountDashboard(() => json(200, PAYLOAD({ rows: [ROW({ feedback_type: null })] })))
    expect(await screen.findByText("FEEDBACK")).toBeTruthy()
  })

  it("identifies the reporter by email, then owner key, then wallet", async () => {
    await mountDashboard(() =>
      json(200, PAYLOAD({
        rows: [
          ROW({ id: 1, user_email: "a@example.test" }),
          ROW({ id: 2, user_email: null, owner_key: "owner-2" }),
          ROW({ id: 3, user_email: null, owner_key: null, user_wallet: "0xabc" }),
          ROW({ id: 4, user_email: null, owner_key: null, user_wallet: null }),
        ],
      })),
    )
    await screen.findByText("a@example.test")
    expect(screen.getByText("owner-2")).toBeTruthy()
    expect(screen.getByText("0xabc")).toBeTruthy()
    expect(screen.getByText("anonymous")).toBeTruthy()
  })

  it("shows the page context and duplicate pointer when present", async () => {
    await mountDashboard(() => json(200, PAYLOAD({ rows: [ROW({ duplicate_of: 7 })] })))
    expect(await screen.findByText("page: /nba-top-shot/sniper")).toBeTruthy()
    expect(screen.getByText("dup of #7")).toBeTruthy()
  })

  it("expands to reveal the details", async () => {
    await mountDashboard()
    const header = await screen.findByText("Sniper feed shows a stale ask")
    expect(screen.queryByText("The ask column lagged by an hour.")).toBeNull()
    fireEvent.click(header)
    expect(await screen.findByText("The ask column lagged by an hour.")).toBeTruthy()
  })

  it("collapses again on a second click", async () => {
    await mountDashboard()
    const header = await screen.findByText("Sniper feed shows a stale ask")
    fireEvent.click(header)
    await screen.findByText("The ask column lagged by an hour.")
    fireEvent.click(header)
    await waitFor(() => expect(screen.queryByText("The ask column lagged by an hour.")).toBeNull())
  })

  it("shows the bot exchange when the row came from the concierge", async () => {
    await mountDashboard(() =>
      json(200, PAYLOAD({ rows: [ROW({ user_message: "why is this $0?", bot_response: "the read failed" })] })),
    )
    fireEvent.click(await screen.findByText("Sniper feed shows a stale ask"))
    expect(await screen.findByText("why is this $0?")).toBeTruthy()
    expect(screen.getByText("the read failed")).toBeTruthy()
  })

  it("renders a relative age", async () => {
    await mountDashboard()
    expect(await screen.findByText("3m ago")).toBeTruthy()
  })
})

// ─── Triage actions ──────────────────────────────────────────────────────────

describe("AdminFeedbackClient — triage actions", () => {
  async function expandRow(over: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(async () => json(200, PAYLOAD({ rows: [ROW(over)] })))
    render(<AdminFeedbackClient />)
    fireEvent.click(await screen.findByText("Sniper feed shows a stale ask"))
    return screen.findByRole("combobox")
  }

  it("PATCHes the new status and applies the returned row", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return json(200, { row: ROW({ feedback_status: "shipped", feedback_summary: "Sniper feed shows a stale ask" }) })
      }
      return json(200, PAYLOAD())
    })
    fireEvent.change(select, { target: { value: "shipped" } })
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")
      expect(patch).toBeTruthy()
      expect(String((patch![1] as RequestInit).body)).toContain('"feedback_status":"shipped"')
    })
    // ⚠ Deliberately NOT asserting the badge text. "Shipped" is also a filter
    // pill label, and `onRowUpdated` triggers a refetch whose fixture still
    // carries the old status — asserting the badge would pin the fixture, not
    // the behaviour.
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit)?.method).length).toBeGreaterThan(1)
    })
  })

  it("does nothing when the status is set to the value it already has", async () => {
    const select = await expandRow()
    const before = fetchMock.mock.calls.length
    fireEvent.change(select, { target: { value: "new" } })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PATCH").length).toBe(0)
    expect(fetchMock.mock.calls.length).toBe(before)
  })

  it("asks which row a duplicate points at, and sends it", async () => {
    const select = await expandRow()
    vi.spyOn(window, "prompt").mockReturnValue("77")
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(200, { row: ROW({ feedback_status: "duplicate", duplicate_of: 77 }) }) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "duplicate" } })
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")
      expect(String((patch![1] as RequestInit).body)).toContain('"duplicate_of":77')
    })
  })

  it("abandons the change when the duplicate prompt is dismissed", async () => {
    const select = await expandRow()
    vi.spyOn(window, "prompt").mockReturnValue(null)
    fireEvent.change(select, { target: { value: "duplicate" } })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(false)
  })

  it("refuses a non-numeric duplicate pointer rather than writing garbage", async () => {
    const select = await expandRow()
    vi.spyOn(window, "prompt").mockReturnValue("not-a-number")
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {})
    fireEvent.change(select, { target: { value: "duplicate" } })
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(false)
  })

  it("refuses a zero or negative duplicate pointer", async () => {
    const select = await expandRow()
    vi.spyOn(window, "prompt").mockReturnValue("0")
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {})
    fireEvent.change(select, { target: { value: "duplicate" } })
    await waitFor(() => expect(alert).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(false)
  })

  it("clears the duplicate pointer when moving a row OFF duplicate", async () => {
    // ⚠ Leaving a stale `duplicate_of` behind would keep a triaged row pointing
    // at an unrelated report — a wrong cross-reference reads as a real one.
    const select = await expandRow({ feedback_status: "duplicate", duplicate_of: 5 })
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(200, { row: ROW({ feedback_status: "reviewed" }) }) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "reviewed" } })
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")
      expect(String((patch![1] as RequestInit).body)).toContain('"duplicate_of":null')
    })
  })

  it("reports a failed PATCH rather than showing the change as applied", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(500, { error: "update failed" }) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "shipped" } })
    await screen.findByText("update failed")
    // The select must not have latched the value it failed to save.
    expect((select as HTMLSelectElement).value).toBe("new")
  })

  it("falls back to the status code when a failed PATCH carries no error", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(502, {}) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "shipped" } })
    await screen.findByText("HTTP 502")
  })

  it("reports a thrown PATCH", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new Error("patch died")
      return json(200, PAYLOAD())
    })
    fireEvent.change(select, { target: { value: "shipped" } })
    await screen.findByText("patch died")
  })

  it("drops back to the gate when a PATCH is rejected as unauthorized", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(401, {}) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "shipped" } })
    await waitFor(() => expect(storedToken).toBeNull())
  })

  it("saves an admin note on blur", async () => {
    await expandRow()
    const note = screen.getByPlaceholderText(/triage notes/i)
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(200, { row: ROW({ admin_note: "chased upstream" }) }) : json(200, PAYLOAD()),
    )
    fireEvent.change(note, { target: { value: "chased upstream" } })
    fireEvent.blur(note)
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")
      expect(String((patch![1] as RequestInit).body)).toContain("chased upstream")
    })
  })

  it("does not write on blur when the note is unchanged", async () => {
    await expandRow({ admin_note: "existing" })
    fireEvent.blur(screen.getByPlaceholderText(/triage notes/i))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "PATCH")).toBe(false)
  })

  it("sends null rather than an empty string when a note is cleared", async () => {
    // An empty string and "no note" are different states in the DB; writing ""
    // makes an un-noted row indistinguishable from a deliberately blanked one.
    await expandRow({ admin_note: "existing" })
    const note = screen.getByPlaceholderText(/triage notes/i)
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(200, { row: ROW({ admin_note: null }) }) : json(200, PAYLOAD()),
    )
    fireEvent.change(note, { target: { value: "" } })
    fireEvent.blur(note)
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")
      expect(String((patch![1] as RequestInit).body)).toContain('"admin_note":null')
    })
  })

  it("leaves the row untouched when the PATCH returns no row", async () => {
    const select = await expandRow()
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      init?.method === "PATCH" ? json(200, {}) : json(200, PAYLOAD()),
    )
    fireEvent.change(select, { target: { value: "shipped" } })
    await new Promise((r) => setTimeout(r, 30))
    expect((select as HTMLSelectElement).value).toBe("new")
  })

  it("auto-refreshes on its own timer", async () => {
    // ⚠ Fake timers must be installed BEFORE the interval is registered —
    // switching to them after mount leaves the real 60s interval in place and
    // `advanceTimersByTime` has nothing to advance. The probe promise chain
    // needs its own flush, hence two advances rather than one.
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(async () => json(200, PAYLOAD()))
      render(<AdminFeedbackClient />)
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(400)
      const before = fetchMock.mock.calls.length
      expect(before).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(61_000)
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not request rows once the stored token has vanished", async () => {
    // ⚠ `handleUnauthorized` clears the token and calls `window.location.reload()`,
    // which jsdom does not implement — so the component stays mounted here and
    // the observable property is that no authenticated request goes out, not
    // that the gate re-renders.
    await mountDashboard()
    storedToken = null
    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }))
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})
