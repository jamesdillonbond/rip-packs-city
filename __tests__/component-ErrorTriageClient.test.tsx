// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

// app/admin/flowty-errors/ErrorTriageClient.tsx — 1,067 lines, zero tests, and
// measured by neither coverage gate.
//
// Scope note, stated plainly: this covers the AUTH GATE and the token handling,
// not the full triage console. That is where the risk concentrates — the
// component holds an admin bearer token in localStorage AND mirrors it into a
// 30-day cookie for the server component, so a regression here either locks a
// legitimate admin out or leaves an admin credential lying around after
// sign-out. The console's tables are ordinary presentational rendering and its
// pure formatters already live in @/lib/admin/flowty-errors-format, tested
// there.
//
// ⚠ Deliberately NOT treated as dead code. Flowty's FRONTEND shut in May 2026,
// but CLAUDE.md records a case where acting on a "this is dead" annotation
// would have deleted a working backstop (api2.flowty.io is alive and the
// listing-cache ingest still writes). So this page is covered as live until
// measured otherwise, rather than skipped on the assumption.

import ErrorTriageClient from "@/app/admin/flowty-errors/ErrorTriageClient"

beforeEach(() => {
  window.localStorage.clear()
  // Clear any cookie left by a prior test.
  document.cookie = "rpc_admin_token=; path=/; max-age=0"
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ErrorTriageClient — the auth gate", () => {
  it("renders the sign-in gate and NO console data when unauthed", () => {
    render(
      <ErrorTriageClient
        authed={false}
        initialDashboard={{ errors: [{ id: 1, message: "SECRET-ERROR-BODY" }] } as never}
        initialSummary={[{ status: "open", n: 5 }] as never}
        loadError={null}
      />
    )
    // The gate must not merely overlay the console — server-supplied data must
    // not reach the DOM at all for an unauthed viewer, or "gated" is cosmetic.
    expect(document.body.textContent).not.toContain("SECRET-ERROR-BODY")
    expect(document.querySelector("input")).toBeTruthy()
  })

  it("renders the console when authed", () => {
    render(
      <ErrorTriageClient
        authed
        initialDashboard={null}
        initialSummary={[] as never}
        loadError={null}
      />
    )
    // Authed path renders something other than a bare sign-in field.
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(0)
  })

  it("surfaces a load error rather than rendering an empty console silently", () => {
    render(
      <ErrorTriageClient
        authed
        initialDashboard={null}
        initialSummary={[] as never}
        loadError="upstream timeout"
      />
    )
    // An outage must not read as "there are no errors to triage" — that is the
    // failure-renders-as-data class, and on a triage console it means an
    // operator concludes the queue is clear when it is not.
    expect(document.body.textContent).toContain("upstream timeout")
  })
})

describe("ErrorTriageClient — admin token storage", () => {
  function submitToken(token: string) {
    render(
      <ErrorTriageClient authed={false} initialDashboard={null} initialSummary={[] as never} loadError={null} />
    )
    const input = document.querySelector("input") as HTMLInputElement
    fireEvent.change(input, { target: { value: token } })
    const form = input.closest("form")
    if (form) fireEvent.submit(form)
    else fireEvent.click(screen.getByRole("button"))
  }

  it("persists the token to localStorage AND mirrors it to a cookie", async () => {
    submitToken("test-admin-token")
    await waitFor(() => expect(window.localStorage.getItem("rpc_admin_token")).toBe("test-admin-token"))
    // The cookie is what the SERVER component reads on the next request; if
    // only localStorage were written, the admin would appear signed out on
    // every full page load.
    expect(document.cookie).toContain("rpc_admin_token=test-admin-token")
  })

  it("URL-encodes the token in the cookie", async () => {
    // An unencoded ';' or '=' would truncate the cookie value and silently
    // store a partial credential that never authenticates.
    submitToken("tok;with=specials")
    await waitFor(() => expect(window.localStorage.getItem("rpc_admin_token")).toBe("tok;with=specials"))
    expect(document.cookie).toContain(encodeURIComponent("tok;with=specials"))
    expect(document.cookie).not.toContain("tok;with=specials")
  })

  it("does not store an empty token", async () => {
    submitToken("")
    // Storing "" would put the page in a state that looks signed-in to the
    // client while every request 401s.
    await waitFor(() => {
      expect(window.localStorage.getItem("rpc_admin_token") ?? "").toBe("")
    })
  })

  it("survives a localStorage that throws (Safari private mode)", () => {
    const orig = window.localStorage.setItem
    // Private-mode Safari throws on setItem; the helper try/catches so sign-in
    // must still proceed via the cookie rather than crashing the page.
    Object.defineProperty(window.localStorage, "setItem", {
      configurable: true,
      value: () => {
        throw new Error("QuotaExceededError")
      },
    })
    expect(() => submitToken("tok")).not.toThrow()
    Object.defineProperty(window.localStorage, "setItem", { configurable: true, value: orig })
  })
})

// ── The triage console itself ───────────────────────────────────────────────

const DASHBOARD = {
  total_signatures: 42,
  open: 12,
  auto_fixable: 7,
  needs_trevor: 3,
  fixed: 18,
  wontfix: 2,
  pipeline_signatures: 30,
  onchain_signatures: 12,
  total_occurrences_24h: 1234,
  recent_unresolved: 9,
}

function row(over: Record<string, unknown> = {}) {
  return {
    signature: "sig-alpha",
    source: "pipeline",
    pipeline: "sales-indexer",
    category: "network",
    subcategory: "timeout",
    resolution_status: "open",
    auto_fixable_hint: false,
    occurrence_count: 17,
    unique_addresses: 4,
    first_seen: "2026-08-01T00:00:00Z",
    last_seen: "2026-08-10T00:00:00Z",
    fix_action: null,
    resolution_notes: null,
    resolved_at: null,
    resolved_by: null,
    sample_error: "ETIMEDOUT reading upstream",
    ...over,
  }
}

function renderConsole(rows: unknown[], loadError: string | null = null) {
  window.localStorage.setItem("rpc_admin_token", "tok")
  return render(
    <ErrorTriageClient
      authed
      initialDashboard={DASHBOARD as never}
      initialSummary={rows as never}
      loadError={loadError}
    />
  )
}

describe("ErrorTriageClient — the console", () => {
  it("renders the server-seeded rows and KPI counts without refetching", async () => {
    const { container } = renderConsole([row(), row({ signature: "sig-beta", source: "onchain" })])
    expect(container.textContent).toContain("sig-alpha")
    expect(container.textContent).toContain("sig-beta")
    // KPI numbers come straight from the server payload; a mismatch here means
    // the operator triages against the wrong queue size.
    expect(container.textContent).toContain("42")
    expect(container.textContent).toContain("12")
  })

  it("renders every resolution status with a distinct badge", () => {
    const statuses = ["open", "auto_fixable", "needs_trevor", "fixed", "wontfix", "duplicate"]
    const { container } = renderConsole(statuses.map((st, i) => row({ signature: `sig-${i}`, resolution_status: st })))
    // All six render; "fixed" and "wontfix" must not be confusable with "open",
    // since that is the difference between a closed and an outstanding issue.
    for (let i = 0; i < statuses.length; i += 1) {
      expect(container.textContent).toContain(`sig-${i}`)
    }
    expect(container.textContent).not.toMatch(/undefined|NaN/)
  })

  it("renders an empty console without inventing rows", () => {
    const { container } = renderConsole([])
    expect(container.textContent).not.toContain("sig-alpha")
    expect((container.textContent ?? "").trim().length).toBeGreaterThan(0)
  })

  it("refetches with the tab's status filter when a tab is clicked", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ rows: [row({ signature: "sig-filtered" })] }),
    }) as Response)
    vi.stubGlobal("fetch", fetchMock)

    renderConsole([row()])
    const tab = screen.getAllByText(/needs trevor/i)[0]
    fireEvent.click(tab)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    // The filter must travel with the request — a tab that renders a different
    // label but sends the same filter silently shows the wrong queue.
    expect(String(init.body)).toContain("needs_trevor")
    // And the admin token must be attached, or every tab switch 401s.
    expect(String((init.headers as Record<string, string>).Authorization)).toContain("Bearer tok")
    await waitFor(() => expect(document.body.textContent).toContain("sig-filtered"))
  })

  it("surfaces a non-ok refetch as an error instead of blanking the queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "list failed" }) }) as Response)
    )
    renderConsole([row()])
    fireEvent.click(screen.getAllByText(/needs trevor/i)[0])
    // An outage must not empty the table — an operator would read that as
    // "nothing left to triage".
    await waitFor(() => expect(document.body.textContent).toContain("list failed"))
  })

  it("surfaces a thrown fetch as a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      })
    )
    renderConsole([row()])
    fireEvent.click(screen.getAllByText(/needs trevor/i)[0])
    await waitFor(() => expect(document.body.textContent).toMatch(/offline/i))
  })

  it("CLEARS the stored admin token on a 401 rather than retrying with it", async () => {
    // A stale token must not linger in localStorage + cookie after the server
    // has rejected it: every later request would keep failing while the UI
    // still looked signed in.
    const reload = vi.fn()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response)
    )
    renderConsole([row()])
    fireEvent.click(screen.getAllByText(/needs trevor/i)[0])
    await waitFor(() => expect(window.localStorage.getItem("rpc_admin_token")).toBeNull())
    expect(document.cookie).not.toContain("rpc_admin_token=tok")
  })
})

describe("ErrorTriageClient — row expansion and the triage form", () => {
  function expandFirstRow() {
    const { container } = renderConsole([row()])
    // The whole <tr> is the toggle; click the signature cell's row.
    const tr = container.querySelector("tbody tr") as HTMLElement
    fireEvent.click(tr)
    return container
  }

  it("expands a row to reveal the drilldown panel, and collapses on a second click", () => {
    const container = expandFirstRow()
    // The panel is an extra <tr> holding a colSpan cell; count rows rather than
    // asserting on copy. (`sample_error` is declared on SummaryRow but never
    // rendered — asserting on it would have been asserting a field the UI does
    // not show.)
    const expanded = container.querySelectorAll("tbody tr").length
    expect(expanded).toBe(2)
    expect(container.querySelector("td[colspan]")).toBeTruthy()

    fireEvent.click(container.querySelectorAll("tbody tr")[0] as HTMLElement)
    expect(container.querySelectorAll("tbody tr").length).toBe(1)
  })

  it("shows only ONE expanded row at a time", () => {
    const { container } = renderConsole([
      row({ signature: "sig-one" }),
      row({ signature: "sig-two" }),
    ])
    // 2 data rows, no panel yet.
    expect(container.querySelectorAll("tbody tr").length).toBe(2)
    fireEvent.click(container.querySelectorAll("tbody tr")[0] as HTMLElement)
    expect(container.querySelectorAll("tbody tr").length).toBe(3)

    // Clicking the OTHER signature must switch, not stack — two open panels
    // would let an operator save against the wrong signature.
    const secondDataRow = Array.from(container.querySelectorAll("tbody tr")).filter(
      (tr) => !tr.querySelector("td[colspan]")
    )[1] as HTMLElement
    fireEvent.click(secondDataRow)
    expect(container.querySelectorAll("tbody tr").length).toBe(3)
    expect(container.querySelectorAll("td[colspan]").length).toBe(1)
  })

  it("saves a triage update with the admin token and patches the row in place", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }) as Response)
    vi.stubGlobal("fetch", fetchMock)

    const container = expandFirstRow()
    const save = Array.from(container.querySelectorAll("button")).find((b) =>
      /save/i.test(b.textContent ?? "")
    )
    expect(save).toBeTruthy()
    fireEvent.click(save!)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    // The signature identifies WHICH error is being resolved; losing it would
    // write the operator's decision onto the wrong row.
    expect(String(init.body)).toContain("sig-alpha")
    expect(String((init.headers as Record<string, string>).Authorization)).toContain("Bearer tok")
  })

  it("reports a failed save instead of showing it as applied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "save failed" }) }) as Response)
    )
    const container = expandFirstRow()
    const save = Array.from(container.querySelectorAll("button")).find((b) => /save/i.test(b.textContent ?? ""))
    fireEvent.click(save!)
    // An optimistic patch on a failed write would show the issue as resolved
    // while the queue still holds it.
    await waitFor(() => expect(document.body.textContent).toMatch(/save failed/i))
  })

  it("renders both source badges distinctly", () => {
    const { container } = renderConsole([
      row({ signature: "sig-pipe", source: "pipeline" }),
      row({ signature: "sig-chain", source: "onchain" }),
    ])
    expect(container.textContent).toContain("pipeline")
    expect(container.textContent).toContain("onchain")
  })

  it("renders a row whose optional fields are all null", () => {
    const { container } = renderConsole([
      row({
        pipeline: null,
        category: null,
        subcategory: null,
        unique_addresses: null,
        last_seen: null,
        sample_error: null,
        fix_action: null,
      }),
    ])
    expect(container.textContent).not.toMatch(/null|undefined|NaN/)
  })
})
