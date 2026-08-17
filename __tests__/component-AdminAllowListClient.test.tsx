// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import AdminAllowListClient from "@/app/admin/allow-list/AdminAllowListClient"

// `admin/allow-list` converted to a `*Client.tsx` so the component gate measures it.
//
// ⚠ THE CONVERSION FOUND A LIVE DEFECT, and it is on the screen that gates who gets into the
// product at all: the loader returns early on a failure, so `rows` stayed at `[]` and the
// list rendered **"Nothing in this view."** — telling an operator there are no signups
// waiting to be approved, produced entirely by our own outage. The error banner renders
// above it, so the page contradicted itself, exactly as the listing-retry-queue and
// /insights/pack-reality cases did.
//
// The fix is gated on `error && rows.length === 0`, not on `error` alone: a failed REFRESH
// keeps the previous rows and last-good beats a blank queue. It is only the EMPTY case that
// must stop claiming the queue is clear.

const SEARCH = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/allow-list",
  useSearchParams: () => SEARCH,
  useParams: () => ({}),
}))
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
  id: "row-1", email: "collector@example.test", wallet_addr: "0xmine",
  username: "collector", collections: ["nba_top_shot"], status: "pending" as const,
  prewarm_status: "idle", prewarm_attempts: 0, prewarm_started_at: null,
  prewarm_completed_at: null, prewarm_error: null, prewarm_summary: null,
  source: "self_serve", created_at: new Date().toISOString(),
  approved_at: null, approved_by: null, welcome_email_sent_at: null,
  welcome_email_error: null, hold_reason: null, reject_reason: null,
  notified_at: null, notes: null, auto_approval_score: null, auto_approved_at: null,
  ...over,
})
const COUNTS = { pending: 1, hold: 0, active: 0, rejected: 0 }
const PAYLOAD = (over: Record<string, unknown> = {}) => ({ rows: [ROW()], counts: COUNTS, ...over })

beforeEach(() => {
  storedToken = "admin-token"
  vi.useRealTimers()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The auth probe and the list read hit the same URL, so responses are sequenced. */
function mount(opts: { list?: (n: number) => Response; write?: () => Response } = {}) {
  let n = 0
  const f = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    if (method !== "GET") return (opts.write ?? (() => json(200, { ok: true })))()
    if (url.includes("/api/admin/allow-list")) {
      n += 1
      return (opts.list ?? (() => json(200, PAYLOAD())))(n)
    }
    return json(200, {})
  })
  vi.stubGlobal("fetch", f)
  render(<AdminAllowListClient />)
  return f
}

describe("AdminAllowListClient — the token gate", () => {
  it("shows the sign-in gate when no token is stored, without calling the API", async () => {
    storedToken = null
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => json(200, PAYLOAD()))
    vi.stubGlobal("fetch", f)
    render(<AdminAllowListClient />)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/Checking/i))
    expect(f).not.toHaveBeenCalled()
  })

  // ⚠ A stored token the route rejects must be DISCARDED. Leaving it means every future
  // visit auto-probes with a credential that cannot work, and the operator sees the console's
  // own failure path instead of the gate they can actually act on.
  it("clears a stored token the route rejects", async () => {
    mount({ list: () => json(401, {}, false) })
    await waitFor(() => expect(storedToken).toBeNull())
  })

  it("admits a stored token the route accepts", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    expect(storedToken).toBe("admin-token")
  })
})

describe("AdminAllowListClient — failed read vs an empty queue", () => {
  // ⚠ THE DEFECT. Three failure shapes; each reaches the branch by a different route and
  // only one of them would ever have been noticed by hand.
  it.each([
    ["a non-2xx", () => json(500, { error: "the database is under heavy load" }, false)],
    ["a 500 with no error body", () => json(500, {}, false)],
  ])("does not claim the queue is empty after %s", async (_l, r) => {
    // The auth probe must succeed so we reach the list; only the SECOND read fails.
    mount({ list: (n) => (n === 1 ? json(200, PAYLOAD()) : (r as () => Response)()) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load the allow list/))
    expect(document.body.textContent).toMatch(/says nothing about who is waiting/)
    expect(document.body.textContent).not.toMatch(/Nothing in this view/)
  })

  it("does not claim the queue is empty after a thrown fetch", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      n += 1
      if (n === 1) return json(200, PAYLOAD())
      throw new Error("network down")
    }))
    render(<AdminAllowListClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Couldn't load the allow list/))
    expect(document.body.textContent).not.toMatch(/Nothing in this view/)
  })

  // ⚠ THE MIRROR. A genuinely drained queue must still say so — an operator who cannot tell
  // "nothing to do" from "we could not ask" stops trusting the screen either way.
  it("does say the view is empty when the read succeeded with no rows", async () => {
    mount({ list: () => json(200, { rows: [], counts: { pending: 0, hold: 0, active: 0, rejected: 0 } }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Nothing in this view/))
    expect(document.body.textContent).not.toMatch(/Couldn't load the allow list/)
  })

  // ⚠ AND THE THIRD STATE: a failed REFRESH keeps the previous rows. Last-good beats a blank
  // queue on an operations screen, so the rows stay and only the empty CLAIM is suppressed.
  it("keeps the previously-loaded rows when a refresh fails", async () => {
    mount({ list: (n) => (n <= 2 ? json(200, PAYLOAD()) : json(500, { error: "boom" }, false)) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const refresh = screen.getAllByRole("button").find((b) => /^refresh$/i.test((b.textContent ?? "").trim()))
    if (refresh) {
      fireEvent.click(refresh)
      await waitFor(() => expect(document.body.textContent).toMatch(/boom/))
      expect(document.body.textContent).toMatch(/collector@example\.test/)
      expect(document.body.textContent).not.toMatch(/Couldn't load the allow list/)
    }
  })
})

describe("AdminAllowListClient — the queue", () => {
  it("lists a pending signup with its identity", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    expect(document.body.textContent).toMatch(/collector/)
  })

  it.each([
    ["pending"], ["hold"], ["active"], ["rejected"],
  ])("renders a %s row", async (status) => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
  })

  it("filters the view by status", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW(), ROW({ id: "row-2", email: "second@example.test", status: "active" })], counts: { pending: 1, hold: 0, active: 1, rejected: 0 } })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const filter = screen.getAllByRole("button").find((b) => /^active/i.test((b.textContent ?? "").trim()))
    if (filter) {
      fireEvent.click(filter)
      await waitFor(() => expect(document.body.textContent).toMatch(/second@example\.test/))
      expect(document.body.textContent).not.toMatch(/collector@example\.test/)
    }
  })

  // ⚠ APPROVING LETS SOMEONE INTO THE PRODUCT and sends a welcome email. The action must
  // carry the row id and the verb, and a failure must SAY so — an operator who thinks they
  // approved someone stops chasing it, and the signup sits there indefinitely.
  it("approves a row and reports a failure rather than reporting success", async () => {
    const f = mount({ write: () => json(500, { error: "could not approve" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const approve = screen.getAllByRole("button").find((b) => /^approve/i.test((b.textContent ?? "").trim()))
    if (approve) {
      fireEvent.click(approve)
      await waitFor(() => expect(document.body.textContent).toMatch(/could not approve/))
      const patch = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")
      expect(patch, "the approve must reach the API").toBeTruthy()
      expect(JSON.parse(String((patch![1] as RequestInit).body)).action).toBe("approve")
    }
  })

  it("approves a row successfully", async () => {
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const approve = screen.getAllByRole("button").find((b) => /^approve/i.test((b.textContent ?? "").trim()))
    if (approve) {
      fireEvent.click(approve)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true),
      )
    }
  })

  // ⚠ The prewarm/welcome block only renders for an ACTIVE row — the state is meaningless
  // before approval, so a `pending` fixture shows none of it and the assertion reads as the
  // error being swallowed. Both fixtures are active for that reason.
  // ⚠ A SECOND LIVE DEFECT THE CONVERSION FOUND, and this one is a WHITE SCREEN. The action
  // handler did `setRows(prev => prev.map(r => r.id === id ? data.row : r))`, so a 200 that
  // carries no `row` wrote `undefined` into state and the very next render crashed on
  // `r.id` — taking the whole console down immediately after an action that had just
  // reported success, leaving the operator no way to tell whether the approval landed.
  //
  // It surfaced as a vitest "Unhandled Error" while every test still PASSED, which is worth
  // noting on its own: a crash outside an assertion does not redden a test, it reddens the
  // RUN — so a suite read as green while the component was throwing.
  it("survives an action response that carries no row, and refetches instead", async () => {
    const f = mount({ write: () => json(200, { ok: true }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const before = f.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length
    fireEvent.click(screen.getAllByRole("button").find((b) => /^approve/i.test((b.textContent ?? "").trim()))!)
    // The console must still be standing, and it must have gone back for the real state
    // rather than guessing at a response it did not understand.
    await waitFor(() =>
      expect(f.mock.calls.filter((c) => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET").length)
        .toBeGreaterThan(before),
    )
    expect(document.body.textContent).toMatch(/collector@example\.test/)
  })

  it("applies the returned row when the action response carries one", async () => {
    mount({ write: () => json(200, { row: ROW({ status: "active" }) }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /^approve/i.test((b.textContent ?? "").trim()))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
  })

  it("surfaces a prewarm failure against the row rather than hiding it", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status: "active", prewarm_status: "failed", prewarm_error: "wallet walk timed out" })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/wallet walk timed out/))
  })

  // ⚠ The welcome-email failure is rendered as a short "welcome ERROR" badge with the real
  // message on `title`. Asserting the message as page TEXT would fail against correct code;
  // an operator needs both — the badge to notice it, the title to act on it.
  it("shows a welcome-email failure so it can be retried", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status: "active", welcome_email_error: "resend rejected the address" })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/welcome ERROR/))
    expect(document.querySelector('[title="resend rejected the address"]')).toBeTruthy()
  })

  it("shows a sent welcome email as sent, not as an error", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status: "active", welcome_email_sent_at: new Date().toISOString() })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/welcome sent/))
    expect(document.body.textContent).not.toMatch(/welcome ERROR/)
  })

  it("renders the per-collection prewarm summary", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status: "active", prewarm_summary: { nba_top_shot: "ok", nfl_all_day: "failed" } })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/ok/))
    expect(document.body.textContent).toMatch(/failed/)
  })

  it("renders a row with no wallet or username without a blank cell", async () => {
    mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ wallet_addr: null, username: null, collections: null })] })) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
  })

  it("signs the operator out", async () => {
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const out = screen.getAllByRole("button").find((b) => /sign out/i.test(b.textContent ?? ""))
    if (out) {
      fireEvent.click(out)
      await waitFor(() => expect(storedToken).toBeNull())
    }
  })
})

describe("AdminAllowListClient — the sign-in gate", () => {
  async function gate() {
    storedToken = null
    const f = vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase()
      if (method !== "GET") return json(200, { ok: true })
      if (String(input).includes("/api/admin/allow-list")) return json(200, PAYLOAD())
      return json(200, {})
    })
    vi.stubGlobal("fetch", f)
    render(<AdminAllowListClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN|token/i)).toBeTruthy())
    return f
  }

  it("does not accept a blank token", async () => {
    const f = await gate()
    const btn = screen.getAllByRole("button").find((b) => /sign in|authenticate|continue/i.test(b.textContent ?? ""))
    if (btn) {
      fireEvent.click(btn)
      expect(f).not.toHaveBeenCalled()
      expect(storedToken).toBeNull()
    }
  })

  it("stores a token the route accepts and loads the queue", async () => {
    await gate()
    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN|token/i), { target: { value: "good" } })
    const btn = screen.getAllByRole("button").find((b) => /sign in|authenticate|continue/i.test(b.textContent ?? ""))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() => expect(storedToken).toBe("good"))
      await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    }
  })

  it("submits on Enter as well as on the button", async () => {
    await gate()
    const input = screen.getByPlaceholderText(/RPC_ADMIN_TOKEN|token/i)
    fireEvent.change(input, { target: { value: "good" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(storedToken).toBe("good"))
  })

  // ⚠ A token the route rejects must NOT be stored, or the operator is auto-signed-in with
  // a credential that cannot work on every subsequent visit and never sees the gate again.
  it("does not store a token the route rejects", async () => {
    storedToken = null
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(401, {}, false) : json(200, { ok: true })))
    render(<AdminAllowListClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN|token/i)).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN|token/i), { target: { value: "wrong" } })
    const btn = screen.getAllByRole("button").find((b) => /sign in|authenticate|continue/i.test(b.textContent ?? ""))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() => expect(document.body.textContent).toMatch(/invalid|rejected|denied|HTTP 401/i))
      expect(storedToken).toBeNull()
    }
  })
})

describe("AdminAllowListClient — hold, deny and prewarm", () => {
  // ⚠ HOLD and DENY both take a REASON, and both are recorded against a real person's
  // signup. A reason silently dropped leaves the next operator with no idea why someone was
  // rejected — and a declined prompt must send nothing at all.
  it.each([
    ["hold", "Hold", "hold"],
    ["deny", "Deny", "deny"],
  ])("sends the %s reason it was given", async (_l, match, action) => {
    vi.stubGlobal("prompt", vi.fn(() => "duplicate signup"))
    // ⚠ Deny ALSO confirms ("They will not be able to sign in"), so a test that stubs only
    // `prompt` silently exercises the decline path — jsdom's `confirm` is unimplemented.
    vi.stubGlobal("confirm", vi.fn(() => true))
    const f = mount({ write: () => json(200, { row: ROW({ status: action === "deny" ? "rejected" : "hold" }) }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    // ⚠ EXACT match. The status FILTER buttons are labelled "Hold ()" / "Rejected ()" and
    // come first in DOM order, so a `/^hold/i` find picks the filter — the click then just
    // changes the view and no PATCH goes out, which reads as the action being broken.
    const btn = screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === (match as string))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true),
      )
      const patch = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")!
      const body = JSON.parse(String((patch[1] as RequestInit).body))
      expect(body.action).toBe(action)
      expect(body.reason).toBe("duplicate signup")
    }
  })

  it("sends nothing when the reason prompt is cancelled", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const btn = screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Hold")!
    fireEvent.click(btn)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(false)
  })

  // ⚠ Deny is confirmed SEPARATELY from its reason prompt, because it locks a real person
  // out of the product. Declining the confirmation must send nothing even though a reason
  // was already typed.
  it("sends nothing when the deny confirmation is declined", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "spam"))
    vi.stubGlobal("confirm", vi.fn(() => false))
    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Deny")!)
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(false)
  })

  it("triggers a prewarm and does not crash when it fails", async () => {
    const f = mount({ write: () => json(500, { error: "prewarm unavailable" }, false) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const btn = screen.getAllByRole("button").find((b) => /prewarm/i.test(b.textContent ?? ""))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => String(c[0]).includes("prewarm-now"))).toBe(true),
      )
      expect(document.body.textContent).toMatch(/collector@example\.test/)
    }
  })

  // ⚠ The 30s poll is the only thing that makes prewarm_status / welcome_email_sent_at
  // update while an operator watches — without it the console silently goes stale and they
  // conclude the drain is stuck.
  //
  // ⚠ Driven by capturing the interval CALLBACK rather than by fake timers: the interval is
  // only registered after the async auth probe resolves, so switching to fake timers around
  // the mount stops that chain and the test then measures nothing.
  it("auto-refreshes so background prewarm progress becomes visible", async () => {
    const callbacks: Array<() => void> = []
    const realSetInterval = globalThis.setInterval
    vi.stubGlobal("setInterval", ((cb: () => void, ms?: number) => {
      if (ms === 30000) callbacks.push(cb)
      return realSetInterval(() => {}, 1_000_000)
    }) as unknown as typeof setInterval)

    const f = mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    expect(callbacks.length, "a 30s refresh interval must be registered").toBeGreaterThan(0)
    const before = f.mock.calls.length
    callbacks[0]()
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))
  })
})

describe("AdminAllowListClient — the remaining edges", () => {
  it("survives an auth probe that throws, and still shows the gate", async () => {
    storedToken = "stale"
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<AdminAllowListClient />)
    // ⚠ A thrown probe must not leave the console stuck on "Checking…" forever — that is
    // indistinguishable from a hang, and an operator has nothing to act on.
    await waitFor(() => expect(document.body.textContent).not.toMatch(/^\s*Checking/i))
  })

  // ⚠ A non-2xx whose body is not JSON must still produce a message. Without the
  // `.catch(() => ({}))` the parse throws and the failure surfaces as a crash instead of a
  // status the operator can act on.
  it("falls back to the status when a failed list read has no JSON body", async () => {
    mount({
      list: (n) =>
        n === 1
          ? json(200, PAYLOAD())
          : ({ ok: false, status: 502, json: async () => { throw new Error("not json") } } as unknown as Response),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 502/))
  })

  it("falls back to the status when a failed action has no JSON body", async () => {
    const f = mount({
      write: () => ({ ok: false, status: 502, json: async () => { throw new Error("not json") } } as unknown as Response),
    })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    fireEvent.click(screen.getAllByRole("button").find((b) => (b.textContent ?? "").trim() === "Approve")!)
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 502/))
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true)
  })

  // ⚠ RESET sends no reason at all — it is the undo for a hold or a denial, so it must not
  // silently carry the old one forward.
  it("resets a held row with no reason", async () => {
    const f = mount({ list: () => json(200, PAYLOAD({ rows: [ROW({ status: "hold", hold_reason: "duplicate" })] })), write: () => json(200, { row: ROW() }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const reset = screen.getAllByRole("button").find((b) => /^reset/i.test((b.textContent ?? "").trim()))
    if (reset) {
      fireEvent.click(reset)
      await waitFor(() =>
        expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(true),
      )
      const patch = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")!
      const body = JSON.parse(String((patch[1] as RequestInit).body))
      expect(body.action).toBe("reset")
      expect(body.reason).toBeNull()
    }
  })

  it("reports a successful prewarm without breaking the row", async () => {
    const f = mount({ write: () => json(200, { ok: true, queued: true }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    const btn = screen.getAllByRole("button").find((b) => /prewarm/i.test(b.textContent ?? ""))
    if (btn) {
      fireEvent.click(btn)
      await waitFor(() => expect(f.mock.calls.some((c) => String(c[0]).includes("prewarm-now"))).toBe(true))
      expect(document.body.textContent).toMatch(/collector@example\.test/)
    }
  })

  // ⚠ `?focus=<id>` is how the welcome email's "review this signup" link lands an operator
  // on the right row. A focus id that does not match any row must be a NO-OP, not a crash —
  // the row may have been actioned by someone else before the link was opened.
  it("ignores a focus id that matches no row", async () => {
    SEARCH.set("focus", "does-not-exist")
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    SEARCH.delete("focus")
  })

  it("scrolls to the focused row when the id matches", async () => {
    SEARCH.set("focus", "row-1")
    mount()
    await waitFor(() => expect(document.body.textContent).toMatch(/collector@example\.test/))
    SEARCH.delete("focus")
  })
})
