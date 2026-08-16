// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import AdminAnalyticsClient from "@/app/admin/analytics/AdminAnalyticsClient"
import ListingRetryQueueClient from "@/app/admin/listing-retry-queue/ListingRetryQueueClient"

// Two admin pages converted from `page.tsx` to `*Client.tsx` so the COMPONENT gate measures
// them — `app/**/page.tsx` matches neither gate's include, so ~1,100 lines of operator-facing
// branching here were unmeasured.
//
// ⚠ ONE REAL DEFECT CAME OUT OF THE CONVERSION, and it is the class this repo keeps paying
// for: `ListingRetryQueueClient`'s rows table rendered "No rows for this filter" on a FAILED
// read. `fetchRows` returns early on a failure, so `rows` stays at `[]` and the emptiness
// branch fires — the retry queue reported as CLEAR, out of our own outage, on the single
// screen an operator uses to decide whether the drain is working. The error banner rendered
// directly above it, so the page contradicted itself; that is the /insights/pack-reality
// shape exactly (one site consulted `error`, the claim site did not).
//
// ⚠ THE OTHER THING THESE PAGES DO IS DELIBERATE AND MUST NOT BE "HARDENED": a non-2xx puts
// up to 200 characters of the RESPONSE BODY on screen. That is the driver-message leak
// banned everywhere else, and CLAUDE.md carves out exactly this case — the only routes where
// a driver message is acceptable are ones gated on a shared OPERATOR SECRET, where the
// reader is holding the token. It is the sole diagnostic these pages have.

const TOKEN_KEY = "rpc_admin_token"

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response
}
function bad(status: number, body = "") {
  return {
    ok: false,
    status,
    json: async () => {
      try {
        return JSON.parse(body)
      } catch {
        throw new Error("not json")
      }
    },
    text: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
describe("AdminAnalyticsClient — the token gate", () => {
  const OVERVIEW = {
    generated_at: "2026-08-16T00:00:00Z",
    users: { total_signups: 20, active_7d: 4 },
    monetization: { active_pro: 2, stripe_revenue_30d: 1234.5 },
    pipelines: { runs_24h: 900, success_pct: 98.5 },
    insider_signals: { alerts_24h: 3, by_type: { floor_drop: 2 } },
    feature_engagement_7d: { sniper: 11 },
    email: { total: 40, verified: 30 },
    trade_hub: { wishlist_items: 0 },
  }

  it("shows the sign-in gate when no token is held", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => ok({})))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    expect(document.body.textContent).toMatch(/Sign In/)
  })

  // ⚠ No request for a blank token. Sending one produces a 401 the operator then has to
  // interpret as "my token is wrong" when they simply had not typed one.
  it("refuses a blank token without making a request", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => ok({}))
    vi.stubGlobal("fetch", f)
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Token required/))
    expect(f).not.toHaveBeenCalled()
  })

  it("does not store or accept a token the route rejects with 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => bad(401)))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "wrong" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Invalid token/))
    // ⚠ The half that matters: a rejected token must not be cached, or every subsequent
    // visit auto-signs-in with a credential that cannot work and the operator sees the
    // dashboard's own failure path instead of the gate.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("distinguishes a route failure from a bad token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => bad(503, "unavailable")))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "good" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 503/))
    expect(document.body.textContent).not.toMatch(/Invalid token/)
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("reports a network failure rather than silently staying on the form", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => {
      throw new Error("network down")
    }))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "t" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/network down/))
  })

  it("accepts a valid token, caches it, and renders the dashboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => ok(OVERVIEW)))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "secret" } })
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))
    expect(localStorage.getItem(TOKEN_KEY)).toBe("secret")
  })

  it("submits on Enter, not only on the button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_i: unknown, _init?: RequestInit) => ok(OVERVIEW)))
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())

    const input = screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)
    fireEvent.change(input, { target: { value: "secret" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBe("secret"))
  })

  it("goes straight to the dashboard when a token is already cached", async () => {
    localStorage.setItem(TOKEN_KEY, "cached")
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => ok(OVERVIEW))
    vi.stubGlobal("fetch", f)
    render(<AdminAnalyticsClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))
    expect(screen.queryByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeNull()
    expect(String((f.mock.calls[0] ?? [])[1] ? JSON.stringify((f.mock.calls[0] as unknown[])[1]) : "")).toContain("cached")
  })
})

describe("AdminAnalyticsClient — the dashboard", () => {
  const FULL = {
    users: { total_signups: 20, active_24h: 3, active_7d: 4, new_7d: 1, allowed: 20, saved_wallets: 9, users_with_wallets: 7 },
    monetization: { active_pro: 2, founding: 1, stripe_revenue_30d: 1234.5 },
    pipelines: { runs_24h: 900, errors_24h: 12, success_pct: 98.5, distinct_pipelines_active_24h: 30 },
    insider_signals: { alerts_24h: 3, critical_24h: 1, distinct_types: 2, by_type: { floor_drop: 2, sweep: 1 } },
    feature_engagement_7d: { sniper: 11, packs: 4 },
    email: { total: 40, verified: 30, deal_alerts_optin: 12, weekly_digest_optin: 8 },
    trade_hub: { wishlist_items: 5, active_offers: 2, pending_matches: 1, users_with_wishlist: 3 },
  }

  /** The value rendered inside the tile carrying `label`, so an assertion observes the
   *  FIGURE rather than the page. */
  function tileValue(label: string): string {
    const eyebrow = Array.from(document.querySelectorAll(".rpc-stat-eyebrow")).find(
      (el) => (el.textContent ?? "").trim() === label,
    )
    if (!eyebrow) throw new Error(`no tile labelled "${label}"`)
    return (eyebrow.parentElement?.querySelector(".rpc-stat-value")?.textContent ?? "").trim()
  }

  async function mount(first: Response, ...rest: Response[]) {
    localStorage.setItem(TOKEN_KEY, "t")
    const queue = [first, ...rest]
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => queue.length > 1 ? queue.shift()! : queue[0])
    vi.stubGlobal("fetch", f)
    render(<AdminAnalyticsClient />)
    return f
  }

  it("renders every panel", async () => {
    await mount(ok(FULL))
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))
    const body = document.body.textContent ?? ""
    for (const n of ["20", "1,235", "98.5", "floor_drop", "sniper"]) {
      expect(body, `expected ${n} on screen`).toMatch(new RegExp(n.replace(/[.$]/g, "\\$&")))
    }
  })

  // ⚠ THE HONESTY ASSERTION. A block absent from the payload must render an em-dash, never
  // a zero. On an operations board "active_pro: 0" and "we did not receive that block" are
  // opposite conclusions, and only one of them is something to act on.
  it("renders an em-dash for a figure the payload does not carry, never a zero", async () => {
    await mount(ok({ users: {}, monetization: {}, pipelines: {}, insider_signals: {}, feature_engagement_7d: {}, email: {}, trade_hub: {} }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))

    // ⚠ ASSERTED PER TILE. The first version checked the whole page for an em-dash and was
    // VACUOUS — mutation-confirmed: turning `fmtInt`'s absent case into "0" left the test
    // green, because other formatters on the same board still emit one. A page-level search
    // observes the PAGE, not the value; the only way to see this is to read the tile that
    // owns the figure.
    expect(tileValue("Total Signups")).toBe("—")
    expect(tileValue("Active 24h")).toBe("—")
  })

  it("renders a genuine zero as 0, so absent and zero stay distinguishable", async () => {
    // The mirror direction, and the reason the fix cannot simply be "never print 0": zero
    // signups is a real measurement, and collapsing it into an em-dash would hide a working
    // metric behind the same glyph as a missing block.
    await mount(ok({ users: { total_signups: 0, active_24h: 5 } }))
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))
    expect(tileValue("Total Signups")).toBe("0")
    expect(tileValue("Active 24h")).toBe("5")
    expect(tileValue("New 7d")).toBe("—")
  })

  // ⚠ A failed FIRST read must render no panels at all. Rendering them off a null payload
  // would put a full board of em-dashes on screen next to an error, which reads as "every
  // metric is genuinely absent" rather than "we could not ask".
  it("shows the failure and no panels when the first read fails", async () => {
    await mount(bad(500, JSON.stringify({ error: "statement timeout" })))
    await waitFor(() => expect(document.body.textContent).toMatch(/statement timeout/))
    expect(document.body.textContent).not.toMatch(/Signups|Active Pro/i)
  })

  it("falls back to the status when the failure body is not JSON", async () => {
    await mount(bad(502, "<html>bad gateway</html>"))
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 502/))
  })

  it("signs the operator out when the dashboard read 401s mid-session", async () => {
    // The token was valid at sign-in and has since been rotated. Leaving them on a dashboard
    // that silently stops updating is the worst outcome; the gate is the honest answer.
    await mount(bad(401))
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("refresh re-requests, and sign out returns to the gate", async () => {
    const f = await mount(ok(FULL))
    await waitFor(() => expect(document.body.textContent).toMatch(/Platform Analytics/))
    const before = f.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }))
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))

    fireEvent.click(screen.getByRole("button", { name: /sign out/i }))
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("keeps the last good board on screen when a REFRESH fails, with the error above it", async () => {
    // Deliberate: last-good beats a blank operations board. What must not happen is the
    // figures vanishing or resetting to zero.
    const f = await mount(ok(FULL), bad(500, "boom"))
    await waitFor(() => expect(document.body.textContent).toMatch(/1,235/))
    fireEvent.click(screen.getByRole("button", { name: /^refresh$/i }))
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 500|boom/))
    expect(document.body.textContent).toMatch(/1,235/)
    expect(f.mock.calls.length).toBeGreaterThan(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("ListingRetryQueueClient", () => {
  const SUMMARY = {
    total_unresolved: 1234,
    by_collection: { nfl_all_day: 1000, nba_top_shot: 234 },
    by_retry_count: { "0": 500, "10+": 34, "2": 700 },
    oldest_unresolved_age_hours: 12.5,
    last_retry_run_started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_retry_run_ok: true,
    last_retry_run_resolved: 40,
    last_retry_run_still_unresolved: 1194,
    last_retry_run_retry_count_hit_cap: 34,
    generated_at: new Date().toISOString(),
  }
  const ROW = (over: Record<string, unknown> = {}) => ({
    id: 1,
    collection_slug: "nfl_all_day",
    flow_id: "111",
    listing_resource_id: "222",
    failure_reason: "not_found",
    retry_count: 3,
    age_hours: 5.25,
    last_retry_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    ...over,
  })

  /** Routes the summary endpoint and the rows endpoint separately. */
  function routed(summary: () => Response, rows: () => Response) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/rows")) return rows()
      return summary()
    })
  }

  it("asks for a token before making any request", async () => {
    const f = routed(() => ok(SUMMARY), () => ok({ rows: [] }))
    vi.stubGlobal("fetch", f)
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    expect(f).not.toHaveBeenCalled()
  })

  it("ignores a blank submission rather than caching an empty credential", async () => {
    const f = routed(() => ok(SUMMARY), () => ok({ rows: [] }))
    vi.stubGlobal("fetch", f)
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }))
    expect(f).not.toHaveBeenCalled()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it("renders the queue panels from a cached token", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => ok(SUMMARY), () => ok({ rows: [ROW()] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/1,234/))
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/nfl_all_day/)
    expect(body).toMatch(/retry_count = 10\+/)
    expect(body).toMatch(/12\.5h/)
  })

  // The 48h drain target is the whole point of the board; without the hint an operator reads
  // a large number with no idea whether it is out of bounds.
  it("flags an oldest-unresolved age past the 48h drain target", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => ok({ ...SUMMARY, oldest_unresolved_age_hours: 96 }), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/exceeds 48h drain target/))
    // 96h renders in days, not as a four-figure hour count.
    expect(document.body.textContent).toMatch(/4d/)
  })

  it("does not flag an age inside the target", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => ok(SUMMARY), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/1,234/))
    expect(document.body.textContent).not.toMatch(/exceeds 48h/)
  })

  // `null` here means the run has never happened / was not recorded. Rendering it as `false`
  // would report a FAILED retry run, which is a different incident entirely.
  it("renders an unknown last-run outcome as an em-dash, not as false", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(
      () => ok({ ...SUMMARY, last_retry_run_ok: null, last_retry_run_started_at: null, last_retry_run_resolved: null }),
      () => ok({ rows: [] }),
    ))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/never/))
    expect(document.body.textContent).toMatch(/—/)
    expect(document.body.textContent).not.toMatch(/okfalse/)
  })

  it("renders a failed last run as false", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => ok({ ...SUMMARY, last_retry_run_ok: false }), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/okfalse/))
  })

  it("says 'empty' for a genuinely empty breakdown", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => ok({ ...SUMMARY, by_collection: {}, by_retry_count: {} }), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/empty/))
  })

  it("clears a rejected token and says so", async () => {
    localStorage.setItem(TOKEN_KEY, "stale")
    vi.stubGlobal("fetch", routed(() => bad(401), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/Invalid token/))
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy()
  })

  it("surfaces the response body on a non-401 failure (deliberate, operator-secret surface)", async () => {
    localStorage.setItem(TOKEN_KEY, "t")
    vi.stubGlobal("fetch", routed(() => bad(500, "canceling statement due to statement timeout"), () => ok({ rows: [] })))
    render(<ListingRetryQueueClient />)
    await waitFor(() => expect(document.body.textContent).toMatch(/statement timeout/))
    expect(document.body.textContent).toMatch(/HTTP 500/)
    // The panels must not render off a null payload.
    expect(document.body.textContent).not.toMatch(/Total unresolved/)
  })
})

describe("ListingRetryQueueClient — the rows table", () => {
  const SUMMARY = {
    total_unresolved: 2,
    by_collection: { nfl_all_day: 2 },
    by_retry_count: { "1": 2 },
    oldest_unresolved_age_hours: 1,
    last_retry_run_started_at: new Date().toISOString(),
    last_retry_run_ok: true,
    last_retry_run_resolved: 0,
    last_retry_run_still_unresolved: 2,
    last_retry_run_retry_count_hit_cap: 0,
    generated_at: new Date().toISOString(),
  }
  const ROW = (over: Record<string, unknown> = {}) => ({
    id: 1,
    collection_slug: "nfl_all_day",
    flow_id: "111",
    listing_resource_id: "222",
    failure_reason: "not_found",
    retry_count: 3,
    age_hours: 5.25,
    last_retry_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    ...over,
  })

  function mount(rowsResponses: (() => Response)[], force?: () => Response) {
    localStorage.setItem(TOKEN_KEY, "t")
    let i = 0
    const f = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("listing-retry-force")) return force ? force() : ok({ resolved: true })
      if (url.includes("/rows")) {
        const r = rowsResponses[Math.min(i, rowsResponses.length - 1)]
        i += 1
        return r()
      }
      return ok(SUMMARY)
    })
    vi.stubGlobal("fetch", f)
    render(<ListingRetryQueueClient />)
    return f
  }

  // ⚠ THE DEFECT THIS CONVERSION FOUND. Before the fix this rendered "No rows for this
  // filter" — the retry queue reported as CLEAR out of our own failed read, on an operations
  // board, directly beneath an error banner saying the read failed.
  it("does NOT claim the filter is empty when the rows read failed", async () => {
    mount([() => bad(500, "pool timeout")])
    await waitFor(() => expect(document.body.textContent).toMatch(/pool timeout/))
    expect(document.body.textContent).not.toMatch(/No rows for this filter/)
    expect(document.body.textContent).toMatch(/Could not load rows/)
  })

  // The mirror direction: a successful read of zero rows IS an honest answer and must keep
  // reading as one. A fix that blanks every empty state into "unavailable" only moves the
  // dishonesty and cries wolf on the drain having worked.
  it("does say the filter is empty when the read succeeded with no rows", async () => {
    mount([() => ok({ rows: [] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/No rows for this filter/))
    expect(document.body.textContent).not.toMatch(/Could not load rows/)
  })

  it("renders a row with its failure reason and age", async () => {
    mount([() => ok({ rows: [ROW()] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/not_found/))
    expect(document.body.textContent).toMatch(/5\.3|5\.2/)
    expect(document.body.textContent).toMatch(/1h ago/)
  })

  it("renders 'never' rather than an empty cell for a row never retried", async () => {
    mount([() => ok({ rows: [ROW({ last_retry_at: null })] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/not_found/))
    expect(document.body.textContent).toMatch(/never/)
  })

  it("re-requests with the collection filter and resets to the first page", async () => {
    const f = mount([() => ok({ rows: [ROW()] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/not_found/))

    const chip = screen.getAllByRole("button").find((b) => b.textContent === "nfl_all_day")!
    fireEvent.click(chip)
    await waitFor(() =>
      expect(f.mock.calls.some((c) => /collection=nfl_all_day/.test(String(c[0])) && /offset=0\b/.test(String(c[0])))).toBe(true),
    )
  })

  it("sorting re-orders without dropping rows, and toggles direction on a second click", async () => {
    mount([() => ok({ rows: [ROW({ id: 1, retry_count: 1, flow_id: "aaa" }), ROW({ id: 2, retry_count: 9, flow_id: "bbb" })] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/aaa/))

    const header = screen.getAllByRole("columnheader").find((h) => /^retry\b/i.test(h.textContent ?? ""))!
    const order = () => Array.from(document.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "")

    fireEvent.click(header)
    await waitFor(() => expect(order()[0]).toMatch(/bbb/))
    expect(order().length).toBe(2)

    fireEvent.click(header)
    await waitFor(() => expect(order()[0]).toMatch(/aaa/))
    expect(order().length).toBe(2)
  })

  // ⚠ A row is dropped from the table ONLY when the server says it resolved. Dropping it on
  // any 2xx would tell an operator the item cleared when the route may have declined it —
  // and the row then disappears from the one screen that would have shown it still stuck.
  it("removes a row only when the force call reports it resolved", async () => {
    mount([() => ok({ rows: [ROW({ id: 7, flow_id: "seven" })] })], () => ok({ resolved: true }))
    await waitFor(() => expect(document.body.textContent).toMatch(/seven/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /force retry/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).not.toMatch(/seven/))
  })

  it("keeps the row and states the reason when the force call reports it unresolved", async () => {
    mount([() => ok({ rows: [ROW({ id: 7, flow_id: "seven" })] })], () => ok({ resolved: false, reason: "still_missing" }))
    await waitFor(() => expect(document.body.textContent).toMatch(/seven/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /force retry/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/still_missing/))
    expect(document.body.textContent).toMatch(/seven/)
  })

  it("states a force-retry HTTP failure against the row rather than silently doing nothing", async () => {
    mount([() => ok({ rows: [ROW({ id: 7, flow_id: "seven" })] })], () => bad(500, JSON.stringify({ error: "force failed" })))
    await waitFor(() => expect(document.body.textContent).toMatch(/seven/))
    fireEvent.click(screen.getAllByRole("button").find((b) => /force retry/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(document.body.textContent).toMatch(/force failed/))
    expect(document.body.textContent).toMatch(/seven/)
  })

  it("cannot page backwards off the first page", async () => {
    const f = mount([() => ok({ rows: [ROW()] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/not_found/))
    const prev = screen.getAllByRole("button").find((b) => /prev/i.test(b.textContent ?? ""))!
    expect(prev.hasAttribute("disabled")).toBe(true)
    const before = f.mock.calls.length
    fireEvent.click(prev)
    expect(f.mock.calls.length).toBe(before)
  })

  // ⚠ Next disables on a SHORT page, which is how this table knows it has reached the end —
  // it has no total. Without it an operator pages into an empty table and reads it as the
  // queue having drained.
  it("disables next on a short page", async () => {
    mount([() => ok({ rows: [ROW()] })])
    await waitFor(() => expect(document.body.textContent).toMatch(/not_found/))
    const next = screen.getAllByRole("button").find((b) => /next/i.test(b.textContent ?? ""))!
    expect(next.hasAttribute("disabled")).toBe(true)
  })
})
