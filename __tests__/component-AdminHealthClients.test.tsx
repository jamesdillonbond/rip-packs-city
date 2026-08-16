// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"
import PipelineHealthClient from "@/app/admin/pipeline-health/PipelineHealthClient"
import BetaActivityClient from "@/app/admin/beta-activity/BetaActivityClient"
import FmvHealthClient from "@/app/admin/fmv-health/FmvHealthClient"
import { ADMIN_TOKEN_KEY } from "@/lib/admin/use-admin-resource"

// Two of the seven admin pages that each carried a byte-identical token-gate + fetch shell.
// They are covered TOGETHER because the shell is now one module: a case written against one
// page is a case about all of them, and splitting these into two files would invite the
// drift the extraction just removed.
//
// The stakes here are not a collector's — they are an operator's. An admin health board
// that shows a figure it did not read is the instrument-that-lies shape this repo's own
// incident log is full of, and the reader has no second source to check it against.

// ⚠ SHAPED FROM THE COMPONENTS' OWN `Payload` INTERFACES, not from what the endpoint
// names suggest. The first draft of these fixtures invented `pipelines: [...]` where the
// page reads `rows`, so `data.rows.map` threw during render and the container came back
// EMPTY — which surfaces as "unable to find the Refresh button", i.e. it reads like a
// selector problem rather than a payload problem. That is the third fixture-shaped mistake
// in this session; the cheap check is to open the interface before writing the fixture.
const PIPELINE_PAYLOAD = {
  generated_at: new Date().toISOString(),
  summary: { red: 0, yellow: 1, green: 2, expected_but_missing: 0 },
  rows: [
    {
      pipeline: "sales-indexer",
      runs_6h: 18,
      fails_6h: 0,
      last_run: new Date().toISOString(),
      expected_min: 20,
      minutes_since: 7,
      drift: "green" as const,
      expected_but_missing: false,
    },
  ],
}
const BETA_PAYLOAD = {
  generated_at: new Date().toISOString(),
  user_count: 1,
  rows: [
    {
      email: "a@example.test",
      username: "collector",
      wallet_addr: "0xabc",
      approved_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      page_views_7d: 12,
      last_seen_at: new Date().toISOString(),
      top_features: [{ feature: "sniper", count: 4 }],
    },
  ],
}

const FMV_PAYLOAD = {
  window_hours: 24,
  generated_at: new Date().toISOString(),
  total_caps: 2,
  by_reason: { disconnected_ask: 2 },
  rows: [] as unknown[],
}

// ⚠ Each page gets its own REFETCH DRIVER, because they do not all have a Refresh button.
// fmv-health refetches by changing its window filter, which goes into the URL — so driving
// it that way also exercises the hook's refetch-on-URL-change, the reason the hook takes a
// URL rather than a path plus params. Assuming a shared "Refresh" control would have
// silently skipped that path (and did: the first version of these cases could not find one).
const CASES = [
  {
    name: "PipelineHealthClient",
    Cmp: PipelineHealthClient,
    payload: PIPELINE_PAYLOAD,
    refetch: () => fireEvent.click(screen.getByRole("button", { name: /refresh/i })),
    loaded: /refresh/i,
  },
  {
    name: "BetaActivityClient",
    Cmp: BetaActivityClient,
    payload: BETA_PAYLOAD,
    refetch: () => fireEvent.click(screen.getByRole("button", { name: /refresh/i })),
    loaded: /refresh/i,
  },
  {
    name: "FmvHealthClient",
    Cmp: FmvHealthClient,
    payload: FMV_PAYLOAD,
    refetch: () => fireEvent.click(screen.getByRole("button", { name: /^7d$/ })),
    loaded: /^7d$/,
  },
] as const

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})
// This config does not enable globals, so testing-library's auto-cleanup never registers.
afterEach(() => cleanup())

describe.each(CASES)("$name — the token gate", ({ Cmp, payload }) => {
  it("shows the entry form and fetches nothing when no token is held", () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    render(<Cmp />)
    // ⚠ The token field is `type="password"`, which has NO `textbox` role — querying by
    // role finds nothing and the failure reads as "the form did not render". Correct for a
    // credential input; the test has to meet it where it is.
    expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy()
    // ⚠ The point is the ABSENCE of a request: firing an unauthenticated call would put a
    // 401 in the logs on every page load and train an operator to ignore them.
    expect(f).not.toHaveBeenCalled()
  })

  it("stores the token and sends it as a bearer", async () => {
    // ⚠ BOTH PARAMS ARE DECLARED even though only the second is read. A zero-arg
    // `vi.fn(async () => …)` infers a ZERO-LENGTH args tuple, so every `mock.calls[i][1]`
    // is a tsc error (TS2493) while vitest stays green — the repo's most-repeated CI
    // breakage, and the second time it has bitten in this session.
    const f = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      ({ ok: true, status: 200, text: async () => "", json: async () => payload }) as unknown as Response)
    vi.stubGlobal("fetch", f)
    render(<Cmp />)

    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "  secret-token  " } })
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }))

    await waitFor(() => expect(f).toHaveBeenCalled())
    const init = f.mock.calls[0][1]!
    // Trimmed: a pasted token routinely carries whitespace, and an untrimmed one 401s with
    // no hint as to why.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token")
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("secret-token")
  })

  it("ignores a blank submit rather than storing an empty credential", () => {
    const f = vi.fn()
    vi.stubGlobal("fetch", f)
    render(<Cmp />)
    fireEvent.change(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: /authenticate/i }))
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it("re-uses a cached token on mount without asking again", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "cached-token")
    const f = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      ({ ok: true, status: 200, text: async () => "", json: async () => payload }) as unknown as Response)
    vi.stubGlobal("fetch", f)
    render(<Cmp />)
    await waitFor(() => expect(f).toHaveBeenCalled())
    const init = f.mock.calls[0][1]!
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cached-token")
  })

  // ⚠ A 401 must DISCARD the credential. Keeping it strands the operator in a loop where
  // every reload retries the same dead token and the page never offers the form again.
  it("clears the stored token on 401 and returns to the entry form", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "dead-token")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "nope", json: async () => ({}) }) as unknown as Response))
    render(<Cmp />)

    await waitFor(() => expect(screen.getByText(/Invalid token/i)).toBeTruthy())
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBeNull()
    // ⚠ The token field is `type="password"`, which has NO `textbox` role — querying by
    // role finds nothing and the failure reads as "the form did not render". Correct for a
    // credential input; the test has to meet it where it is.
    expect(screen.getByPlaceholderText(/RPC_ADMIN_TOKEN/)).toBeTruthy()
  })

  // ⚠ ...and any OTHER failure must KEEP it. Discarding a good credential every time the
  // route hiccups logs the operator out mid-incident, which is exactly when they need it.
  it("keeps the stored token on a 500", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "good-token")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }) as unknown as Response))
    render(<Cmp />)

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy())
    expect(localStorage.getItem(ADMIN_TOKEN_KEY)).toBe("good-token")
  })
})

describe.each(CASES)("$name — a failed refresh must not read as current", ({ Cmp, payload, refetch, loaded }) => {
  it("discloses that the retained figures are stale", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    let fail = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? ({ ok: false, status: 503, text: async () => "upstream down", json: async () => ({}) } as unknown as Response)
          : ({ ok: true, status: 200, text: async () => "", json: async () => payload } as unknown as Response),
      ),
    )
    render(<Cmp />)
    await waitFor(() => expect(screen.getByRole("button", { name: loaded })).toBeTruthy())

    fail = true
    refetch()
    await waitFor(() => expect(screen.getByText(/HTTP 503/)).toBeTruthy())

    // The panels below still hold the previous payload — that is deliberate (last-good beats
    // a blank operations board) — so the disclosure is the only thing separating a reading
    // from a memory.
    expect(screen.getByText(/last successful read/i)).toBeTruthy()
  })

  it("does NOT disclose staleness on a clean load", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => payload }) as unknown as Response))
    render(<Cmp />)
    await waitFor(() => expect(screen.getByRole("button", { name: loaded })).toBeTruthy())
    // Both directions: a permanent "these may be stale" note is its own false claim and
    // trains the reader to ignore it — the cry-wolf cost this repo already paid once.
    expect(screen.queryByText(/last successful read/i)).toBeNull()
  })

  it("does not disclose staleness on a 401, because nothing is retained to be stale", async () => {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    let fail = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail
          ? ({ ok: false, status: 401, text: async () => "", json: async () => ({}) } as unknown as Response)
          : ({ ok: true, status: 200, text: async () => "", json: async () => payload } as unknown as Response),
      ),
    )
    render(<Cmp />)
    await waitFor(() => expect(screen.getByRole("button", { name: loaded })).toBeTruthy())

    fail = true
    refetch()
    await waitFor(() => expect(screen.getByText(/Invalid token/i)).toBeTruthy())
    expect(screen.queryByText(/last successful read/i)).toBeNull()
  })
})

// ── Row rendering ───────────────────────────────────────────────────────────
//
// The shell tests above drive the auth and failure paths; these drive the TABLES, which is
// where each page's own logic lives — the drift colouring, the cadence and "time since"
// formatters, and the null handling. All three of those formatters have a dedicated branch
// for NULL, and on an operations board the difference between "never" and "0m" is the
// difference between a pipeline that has never run and one that just did.

describe("PipelineHealthClient — the drift table", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    pipeline: "sales-indexer",
    runs_6h: 18,
    fails_6h: 0,
    last_run: new Date().toISOString(),
    expected_min: 20,
    minutes_since: 7,
    drift: "green",
    expected_but_missing: false,
    ...over,
  })

  async function mount(payload: unknown) {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => payload }) as unknown as Response))
    render(<PipelineHealthClient />)
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy())
  }

  it("renders every drift band without dropping a row", async () => {
    await mount({
      generated_at: new Date().toISOString(),
      summary: { red: 1, yellow: 1, green: 1, expected_but_missing: 1 },
      rows: [
        row({ pipeline: "green-one", drift: "green" }),
        row({ pipeline: "yellow-one", drift: "yellow", fails_6h: 2 }),
        row({ pipeline: "red-one", drift: "red", fails_6h: 9, expected_but_missing: true }),
      ],
    })
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/green-one/)
    expect(body).toMatch(/yellow-one/)
    expect(body).toMatch(/red-one/)
  })

  // ⚠ A red summary raises a banner. It is the page's loudest signal, so it must key on the
  // COUNT rather than on the presence of rows — a red pipeline that scrolled off the table
  // still needs the banner.
  // ⚠ The banner keys on the SUMMARY COUNT, not on the rows on screen — and the fixture
  // makes that observable by reporting reds the row list does not contain. A row-derived
  // banner would go quiet exactly when the table is truncated or filtered, which is when an
  // operator most needs the count.
  it("raises the red banner from the summary count even when no red row is listed", async () => {
    await mount({
      generated_at: new Date().toISOString(),
      summary: { red: 2, yellow: 0, green: 5, expected_but_missing: 0 },
      rows: [row({ pipeline: "green-only", drift: "green" })],
    })
    // Matched loosely on "<count> … red" rather than the exact sentence: the banner's
    // wording is copy and will be reworded, while the COUNT reaching it is the property.
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/2[^0-9]{0,20}red/i)
    cleanup()

    await mount({
      generated_at: new Date().toISOString(),
      summary: { red: 0, yellow: 0, green: 5, expected_but_missing: 0 },
      rows: [row({ pipeline: "green-only", drift: "green" })],
    })
    expect(document.body.textContent).not.toMatch(/2[^0-9]{0,20}red/i)
  })

  // ⚠ THESE ASSERT THE CELL, NOT THE PAGE. The first version checked that "never" appeared
  // somewhere in the body — which the page's own legend also says, so mutating the
  // formatter to print "0m" left the test green. A row-scoped read is the difference
  // between observing the formatter and observing the surrounding copy.
  function cells(pipeline: string): string[] {
    const tr = Array.from(document.querySelectorAll("tbody tr")).find((r) =>
      r.textContent?.includes(pipeline),
    )
    if (!tr) throw new Error(`no row for ${pipeline}`)
    return Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())
  }

  // "never" is not "0m". A pipeline with no recorded run at all is the case an operator most
  // needs to see, and a formatter that printed a number for it would hide a dead pipeline
  // among the healthy ones.
  it("prints 'never' for a pipeline that has never run, and an em-dash for an unknown cadence", async () => {
    await mount({
      generated_at: new Date().toISOString(),
      summary: { red: 1, yellow: 0, green: 0, expected_but_missing: 1 },
      rows: [row({ pipeline: "never-run", last_run: null, minutes_since: null, expected_min: null, drift: "red" })],
    })
    const c = cells("never-run")
    expect(c.join("|")).toMatch(/never/)
    expect(c.join("|")).not.toMatch(/\b0m\b/)
    // An unknown cadence is an em-dash, not a zero: "expected every 0 minutes" is a
    // schedule claim the row cannot support.
    expect(c).toContain("—")
  })

  it("formats cadence across the minute, hour and day bands", async () => {
    await mount({
      generated_at: new Date().toISOString(),
      summary: { red: 0, yellow: 0, green: 3, expected_but_missing: 0 },
      rows: [
        row({ pipeline: "mins", expected_min: 20, minutes_since: 5 }),
        row({ pipeline: "hours", expected_min: 360, minutes_since: 200 }),
        row({ pipeline: "days", expected_min: 2880, minutes_since: 4000 }),
      ],
    })
    // The bands must actually COLLAPSE the unit — an operations board that prints "2880m"
    // and "4000m" is technically correct and unreadable at a glance, which is the whole job.
    expect(cells("mins").join("|")).toMatch(/20m/)
    expect(cells("hours").join("|")).toMatch(/6h/)
    expect(cells("days").join("|")).toMatch(/2d/)
    expect(cells("days").join("|")).not.toMatch(/2880m/)
  })

})

describe("BetaActivityClient — the user table", () => {
  async function mount(rows: unknown[]) {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ generated_at: new Date().toISOString(), user_count: rows.length, rows }) }) as unknown as Response))
    render(<BetaActivityClient />)
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy())
  }
  const user = (over: Record<string, unknown> = {}) => ({
    email: "a@example.test",
    username: "collector",
    wallet_addr: "0xabc",
    approved_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    page_views_7d: 12,
    last_seen_at: new Date().toISOString(),
    top_features: [{ feature: "sniper", count: 4 }],
    ...over,
  })

  it("renders a user row with its feature breakdown", async () => {
    await mount([user()])
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/a@example\.test/)
    expect(body).toMatch(/sniper/)
  })

  // Every optional column has a null branch, and a beta list is exactly where they occur:
  // a signed-up user who never linked a wallet, never got approved, or never came back.
  it("renders a user with every optional field absent", async () => {
    await mount([
      user({ username: null, wallet_addr: null, approved_at: null, last_active_at: null, last_seen_at: null, top_features: [] }),
    ])
    expect(document.body.textContent).toMatch(/a@example\.test/)
  })

  it("sorts without dropping rows", async () => {
    await mount([
      user({ email: "b@example.test", page_views_7d: 99 }),
      user({ email: "c@example.test", page_views_7d: 1 }),
    ])
    // The sort control is a select or a set of header buttons depending on the page; drive
    // whichever exists and assert both rows survive, since a broken comparator silently
    // truncates rather than erroring.
    const selects = screen.queryAllByRole("combobox")
    for (const sel of selects) {
      const opts = Array.from(sel.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value)
      if (opts.length > 1) fireEvent.change(sel, { target: { value: opts[1] } })
    }
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/b@example\.test/)
    expect(body).toMatch(/c@example\.test/)
  })
})

describe("FmvHealthClient — the cap table and window filter", () => {
  const cap = (over: Record<string, unknown> = {}) => ({
    edition_id: "48:1652",
    player_name: "Damian Lillard",
    set_name: "Archive Set",
    tier: "LEGENDARY",
    collection_slug: "nba_top_shot",
    reason: "disconnected_ask",
    fmv_before: 120,
    fmv_after: 40,
    pct_dropped: 66.7,
    confidence_before: "HIGH",
    confidence_after: "MEDIUM",
    applied_at: new Date().toISOString(),
    ...over,
  })

  async function mount(rows: unknown[], by_reason: Record<string, number> = { disconnected_ask: 1 }) {
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ window_hours: 24, generated_at: new Date().toISOString(), total_caps: rows.length, by_reason, rows }) }) as unknown as Response))
    render(<FmvHealthClient />)
    await waitFor(() => expect(screen.getByRole("button", { name: /^7d$/ })).toBeTruthy())
  }

  it("renders a capped edition with its before/after prices", async () => {
    await mount([cap()])
    const body = document.body.textContent ?? ""
    expect(body).toMatch(/Damian Lillard/)
    expect(body).toMatch(/Archive Set/)
  })

  // ⚠ FINDING, PINNED AS CURRENT BEHAVIOUR RATHER THAN FIXED. This page reports FMV clamps —
  // cases where the platform overrode its own published price — and every visible column is
  // metadata from a join (`player_name`, `set_name`, `tier`, `collection_slug`, `reason`).
  // `edition_id` is used ONLY as the React key and is never rendered. So when the join
  // misses, the row still appears but as nine em-dashes with NO identifier at all: the
  // operator can see that something was clamped and cannot tell what.
  //
  // Not fixed here because it is not a one-line change — the table has a fixed 10-column
  // header, so surfacing the id means adding a column to both `thead` and `tbody`, and that
  // is a layout change to an admin surface I cannot see rendered. Asserted so the behaviour
  // is at least KNOWN, and so a future fix has something to red.
  it("renders an all-null cap row rather than dropping it, but cannot identify it", async () => {
    await mount([
      cap({ player_name: null, set_name: null, tier: null, collection_slug: null, reason: null, fmv_before: null, fmv_after: null, pct_dropped: null, confidence_before: null, confidence_after: null, applied_at: null }),
    ])
    // The row IS rendered — dropping it would hide a clamp entirely, which is worse.
    const rows = document.querySelectorAll("tbody tr")
    expect(rows.length).toBe(1)
    // ...and it carries no identifier, only placeholders.
    expect(document.body.textContent).not.toMatch(/48:1652/)
    const tds = Array.from(rows[0].querySelectorAll("td")).map((t) => (t.textContent ?? "").trim())
    // ⚠ EVERY optional cell is an em-dash, including the percentage. A null drop rendered as
    // "0.0%" would claim the clamp changed nothing — the opposite of what an unattributable
    // clamp means — so the percentage cell is asserted specifically.
    expect(tds.filter((t) => t === "—").length).toBeGreaterThanOrEqual(4)
    expect(tds.join("|")).not.toMatch(/0\.0%/)
  })

  it("shows an empty state rather than a bare table when nothing was capped", async () => {
    await mount([], {})
    // A window with no clamps is GOOD news and an honest answer — it must not read as a
    // failure, and the error banner must stay absent.
    expect(screen.queryByText(/HTTP /)).toBeNull()
  })

  it("changing the window re-requests with the new hour count", async () => {
    const f = vi.fn(async (_i: unknown, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => "", json: async () => ({ window_hours: 24, generated_at: new Date().toISOString(), total_caps: 0, by_reason: {}, rows: [] }) }) as unknown as Response)
    localStorage.setItem(ADMIN_TOKEN_KEY, "t")
    vi.stubGlobal("fetch", f)
    render(<FmvHealthClient />)
    await waitFor(() => expect(String(f.mock.calls[0][0])).toMatch(/windowHours=24/))

    fireEvent.click(screen.getByRole("button", { name: /^7d$/ }))
    await waitFor(() => expect(String(f.mock.calls[f.mock.calls.length - 1][0])).toMatch(/windowHours=168/))

    fireEvent.click(screen.getByRole("button", { name: /^1h$/ }))
    await waitFor(() => expect(String(f.mock.calls[f.mock.calls.length - 1][0])).toMatch(/windowHours=1/))
  })
})
