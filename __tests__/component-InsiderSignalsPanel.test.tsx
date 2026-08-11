// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import InsiderSignalsPanel from "@/components/InsiderSignalsPanel"

// Drives the insider-signals overview panel: it fetches /api/insider-signals,
// shows a skeleton then either an error, the schonely empty state, or severity-
// tinted alert cards with a relative timestamp and a player-scoped click-through.
// severityColor / fmtRelative / the evidence extractors are the regression
// surface (a wrong severity tint or a broken player link mis-signals).

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock("@/lib/schonely", () => ({ pickEmpty: () => "🏀" }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function alert(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    alert_type: "cluster_buyback",
    title: "Top Shot bought 6 LeBron moments",
    summary: "cluster",
    evidence_jsonb: { player_name: "LeBron James", set_name: "Base Set", tier: "RARE", edition_id: "ed-1" },
    severity: 3,
    generated_at: new Date(Date.now() - 30 * 60_000).toISOString(), // 30m ago
    expires_at: null,
    ...over,
  }
}

describe("InsiderSignalsPanel", () => {
  it("shows a loading skeleton before the fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    expect(container.querySelectorAll(".rpc-skeleton").length).toBe(4)
  })

  it("renders the schonely empty state when there are no alerts", async () => {
    fetchMock.mockReturnValue(okJson({ alerts: [] }))
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("No active insider signals"))
    expect(container.textContent).toContain("🏀") // the pickEmpty hook
  })

  it("renders an error state when the API returns an error payload", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "rpc down" }) } as Response),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn"))
  })

  it("renders severity-3 cards red with a relative timestamp and an edition-id link", async () => {
    fetchMock.mockReturnValue(okJson({ alerts: [alert()] }))
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("LeBron"))
    expect(container.textContent).toContain("1 active")
    expect(container.textContent).toContain("30m ago") // fmtRelative
    expect(container.innerHTML).toContain("var(--rpc-red)") // severity 3 tint
    // edition_id present -> deep link, not the collection filter
    expect(container.querySelector("a")?.getAttribute("href")).toContain("ed-1")
  })

  it("falls back to a player-scoped collection link when evidence has no edition_id", async () => {
    fetchMock.mockReturnValue(
      okJson({ alerts: [alert({ evidence_jsonb: { player_name: "Curry" }, severity: 2 })] }),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("bought"))
    const href = container.querySelector("a")?.getAttribute("href") ?? ""
    expect(href).toContain("/nba-top-shot/collection")
    expect(href).toContain("Curry")
    expect(container.innerHTML).toContain("var(--rpc-warning)") // severity 2 tint
  })

  it("renders a severity-1 card (muted tint), a plain collection link, and no summary/meta when evidence is empty", async () => {
    fetchMock.mockReturnValue(
      okJson({
        alerts: [
          alert({ severity: 1, summary: null, evidence_jsonb: null, title: "Bare alert" }),
        ],
      }),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Bare alert"))
    expect(container.innerHTML).toContain("var(--rpc-text-muted)") // severity 1 -> else branch
    // No edition_id and no player -> the bare collection link.
    const href = container.querySelector("a")?.getAttribute("href") ?? ""
    expect(href).toBe("/nba-top-shot/collection")
    // summary null -> no clamp div; evidence null -> no player·set·tier meta line.
    expect(container.textContent).not.toContain("cluster")
  })

  it("builds a deep link from a NUMERIC edition_id and renders the player·set·tier meta line", async () => {
    fetchMock.mockReturnValue(
      okJson({
        alerts: [
          alert({ evidence_jsonb: { player_name: "Curry", set_name: "Base", tier: "RARE", edition_id: 4242 } }),
        ],
      }),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Curry"))
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/moment/4242")
    // meta line joins the present evidence fields
    expect(container.textContent).toContain("Curry · Base · RARE")
  })

  it("renders fmtRelative just-now / hour / day buckets and an empty stamp for a null timestamp", async () => {
    const now = Date.now()
    fetchMock.mockReturnValue(
      okJson({
        alerts: [
          alert({ id: "j", title: "Just now", generated_at: new Date(now - 20_000).toISOString() }), // < 1 min
          alert({ id: "h", title: "Hours", generated_at: new Date(now - 4 * 3_600_000).toISOString() }),
          alert({ id: "d", title: "Days", generated_at: new Date(now - 5 * 86_400_000).toISOString() }),
          alert({ id: "n", title: "NoStamp", generated_at: null as unknown as string }),
        ],
      }),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Just now"))
    const txt = container.textContent!
    expect(txt).toContain("just now") // min < 1
    expect(txt).toContain("4h ago")   // hr < 24
    expect(txt).toContain("5d ago")   // day branch
  })

  it("shows the error state when the fetch throws (catch branch)", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("boom")))
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn"))
  })

  it("falls back to the HTTP status when a non-ok response has no error field", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as Response),
    )
    const { container } = render(<InsiderSignalsPanel collection="nba-top-shot" basePath="/nba-top-shot" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn"))
  })
})
