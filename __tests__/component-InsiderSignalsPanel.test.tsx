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
})
