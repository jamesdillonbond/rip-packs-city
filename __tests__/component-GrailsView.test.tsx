// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// GrailsView — the packs-page grail grid (the Pack-audit B5 Suspense/
// searchParams component). Drives the real fetch -> render path with a stubbed
// /api/packs/grails and pins the at-least-once probability math surfaced on
// the cards plus the loading/error/empty envelopes.

const navState = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock("next/navigation", () => ({
  usePathname: () => "/nba-top-shot/packs",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => navState.params,
}))
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import GrailsView from "@/components/packs/GrailsView"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function grailRow(over: Record<string, unknown> = {}) {
  return {
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    dist_id: "1234",
    edition_count_pullable: 40,
    fmv_coverage_pct: 0.95,
    max_pull_fmv: 2500,
    max_pull_player: "Victor Wembanyama",
    max_pull_set: "Metallic Gold LE",
    max_pull_tier: "LEGENDARY",
    max_pull_thumbnail: null,
    grails_25: 0,
    grails_100: 1,
    grails_500: 2,
    grails_1000: 3,
    ultimate_count: 0,
    legendary_count: 2,
    rare_count: 10,
    weighting_method: "weighted",
    weighted_grail_value_100plus: 120,
    ev_per_slot: 3.2,
    // 1% per slot -> at-least-once over 5 slots = 1-(0.99^5) = 4.90%.
    prob_grail_100_per_slot: 0.01,
    prob_grail_1000_per_slot: 0.001,
    prob_ultimate_per_slot: null,
    meta: {
      title: "2026 Finals Pack",
      image_url: null,
      primary_price: 19,
      secondary_ask: 25,
      pack_ev: 22,
      value_ratio: 1.1,
      total_sealed: 500,
      depletion_pct: 0.4,
      slots: 5,
      primary_available: true,
      secondary_available: true,
    },
    ...over,
  }
}

function stubGrailsApi(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    })) as never,
  )
}

describe("GrailsView", () => {
  it("renders grail cards from the API with the chase player and at-least-once probability", async () => {
    stubGrailsApi({ rows: [grailRow()] })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)

    await waitFor(() => expect(getByText("Victor Wembanyama")).toBeTruthy())
    expect(getByText("2026 Finals Pack")).toBeTruthy()
    // P(at least one $100+ grail across 5 slots) = 1 - 0.99^5 = 4.90%.
    expect(getByText(/4\.9\s*%/)).toBeTruthy()
  })

  it("surfaces the API's error message in the error state", async () => {
    stubGrailsApi({ error: "grail metrics unavailable" }, 500)
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText(/grail metrics unavailable/)).toBeTruthy())
  })

  it("shows an empty state when no grails are indexed", async () => {
    stubGrailsApi({ rows: [] })
    const { container, queryByText } = render(
      <GrailsView collection="nba-top-shot" accent="#E03A2F" />,
    )
    await waitFor(() => {
      expect(queryByText("Victor Wembanyama")).toBeNull()
      // Loading finished into SOME rendered empty-state copy, not a blank div.
      expect((container.textContent ?? "").length).toBeGreaterThan(0)
    })
  })
})
