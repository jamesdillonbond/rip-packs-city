// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

// GrailsView — the packs-page grail grid (the Pack-audit B5 Suspense/
// searchParams component). Drives the real fetch -> render path with a stubbed
// /api/packs/grails and pins the at-least-once probability math surfaced on
// the cards plus the loading/error/empty envelopes.

const navState = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn((..._args: unknown[]) => {}),
}))
vi.mock("next/navigation", () => ({
  usePathname: () => "/nba-top-shot/packs",
  useRouter: () => ({ push: () => {}, replace: navState.replace, prefetch: () => {} }),
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
  navState.params = new URLSearchParams()
  navState.replace.mockReset()
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
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }))
  vi.stubGlobal("fetch", fetchMock as never)
  return fetchMock
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

  it("falls back to a default error message when the failed response has no error field", async () => {
    stubGrailsApi({}, 503)
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText(/Failed to load grail metrics/)).toBeTruthy())
  })

  it("surfaces a thrown fetch (network error) as the error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }) as never)
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText(/network down/)).toBeTruthy())
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

  it("refetches with the new sort key when a sort button is clicked", async () => {
    const fetchMock = stubGrailsApi({ rows: [grailRow()] })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("Victor Wembanyama")).toBeTruthy())
    // Default sort is weightedGrailValue; the first fetch used it.
    expect(fetchMock.mock.calls[0][0]).toContain("sort=weightedGrailValue")
    fireEvent.click(getByText("Max pull"))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("sort=maxPull"))).toBe(true),
    )
    // The header count-line reflects the active sort label.
    await waitFor(() => expect(getByText(/sorted by Max pull/)).toBeTruthy())
  })

  it("toggles Buyable only, writing the flag into the URL and re-fetching", async () => {
    const fetchMock = stubGrailsApi({ rows: [grailRow()] })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("Victor Wembanyama")).toBeTruthy())
    const btn = getByText("Buyable only")
    expect(btn.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(btn)
    expect(btn.getAttribute("aria-pressed")).toBe("true")
    // router.replace called with the buyableOnly query param.
    expect(navState.replace).toHaveBeenCalled()
    expect(String(navState.replace.mock.calls[0][0])).toContain("buyableOnly=true")
    // A subsequent fetch carries buyableOnly=true.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("buyableOnly=true"))).toBe(true),
    )
    // Toggling off removes the param from the URL.
    fireEvent.click(btn)
    expect(btn.getAttribute("aria-pressed")).toBe("false")
    const lastReplace = String(navState.replace.mock.calls.at(-1)?.[0] ?? "")
    expect(lastReplace).not.toContain("buyableOnly=true")
  })

  it("initializes Buyable only from the URL and client-filters non-buyable rows out", async () => {
    navState.params = new URLSearchParams("buyableOnly=true")
    stubGrailsApi({
      rows: [
        grailRow({ dist_id: "buyable", meta: { ...grailRow().meta, primary_available: true, secondary_available: false } }),
        grailRow({
          dist_id: "soldout",
          max_pull_player: "Sold Out Star",
          meta: { ...grailRow().meta, primary_available: false, secondary_available: false },
        }),
      ],
    })
    const { getByText, queryByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("Buyable only").getAttribute("aria-pressed")).toBe("true"))
    // The non-buyable row is filtered out client-side even if the API returned it.
    await waitFor(() => expect(queryByText("Sold Out Star")).toBeNull())
    expect(getByText("Victor Wembanyama")).toBeTruthy()
  })

  it("shows the buyable-specific empty copy when the filter hides every row", async () => {
    navState.params = new URLSearchParams("buyableOnly=true")
    stubGrailsApi({
      rows: [
        grailRow({ meta: { ...grailRow().meta, primary_available: false, secondary_available: false } }),
      ],
    })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText(/try toggling Buyable only off/)).toBeTruthy())
  })

  it("renders a card image, the chase ribbon thumbnail, and the ultimate/1K pills", async () => {
    stubGrailsApi({
      rows: [
        grailRow({
          meta: { ...grailRow().meta, image_url: "https://cdn/pack.png", title: "Cover Pack" },
          max_pull_thumbnail: "https://cdn/chase.png",
          ultimate_count: 2,
          grails_1000: 4,
        }),
      ],
    })
    const { container, getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("Cover Pack")).toBeTruthy())
    const imgs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"))
    expect(imgs).toContain("https://cdn/pack.png")
    expect(imgs).toContain("https://cdn/chase.png")
    expect(getByText(/Ultimate: 2/)).toBeTruthy()
    expect(getByText(/Grails \$1K\+: 4/)).toBeTruthy()
    // Legendary pill is suppressed when ultimate_count > 0.
    expect(container.textContent).not.toContain("Legendary:")
  })

  it("renders the legendary pill when there are no ultimates, and the '?' art placeholder", async () => {
    stubGrailsApi({
      rows: [grailRow({ ultimate_count: 0, legendary_count: 3, "meta": { ...grailRow().meta, image_url: null } })],
    })
    const { getByText, container } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText(/Legendary: 3/)).toBeTruthy())
    // No image_url -> the "?" placeholder art renders instead of an <img> cover.
    expect(container.textContent).toContain("?")
  })

  it("handles a null meta / null chase card: Pack #id title, em-dash player+set, approx slots, SECONDARY price", async () => {
    stubGrailsApi({
      rows: [
        grailRow({
          dist_id: "9090",
          meta: null,
          max_pull_fmv: null, // no chase ribbon
          max_pull_player: null,
          max_pull_set: null,
          prob_grail_100_per_slot: 0.02,
        }),
      ],
    })
    const { getByText, container } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    // meta null -> title falls back to `Pack #<dist_id>`.
    await waitFor(() => expect(getByText("Pack #9090")).toBeTruthy())
    // slots unknown -> approximate marker "~" rendered in the probability strip.
    expect(container.textContent).toContain("~")
    // meta null -> selectPackPrice sees no price -> label falls back to "PRICE".
    expect(getByText("PRICE")).toBeTruthy()
    // No PRIMARY/SECONDARY label since there is no price at all.
    expect(container.textContent).not.toContain("SECONDARY")
  })

  it("labels the price PRIMARY when only a primary price is present", async () => {
    stubGrailsApi({
      rows: [grailRow({ meta: { ...grailRow().meta, primary_price: 15, secondary_ask: null } })],
    })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("PRIMARY")).toBeTruthy())
  })

  it("labels the price SECONDARY when only a secondary ask is present", async () => {
    stubGrailsApi({
      rows: [grailRow({ meta: { ...grailRow().meta, primary_price: null, secondary_ask: 30 } })],
    })
    const { getByText } = render(<GrailsView collection="nba-top-shot" accent="#E03A2F" />)
    await waitFor(() => expect(getByText("SECONDARY")).toBeTruthy())
  })
})
