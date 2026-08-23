// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// Interaction + per-row branch coverage for the two lowest-branch public
// /insights board clients (PinnacleScarcity 43.6% br, SerialPremiums 47.2% br
// as of 2026-08-08). The existing smoke + populated-row suites render the
// DEFAULT view; what stayed dark is the progressive-enhancement layer that a
// real visitor drives — the filter pills / sort selects / tab toggles that
// REFETCH, the money/percent/multiple formatter BANDS, the tier-color ladder,
// and the per-row conditional cells (chaser chip, conflation badge, null "—"
// fallbacks, image onError fallback). A regression in any of those shows a
// visitor a wrong sort, a wrong filter, or a silent "$0"/"—" where a real
// number belongs — exactly the class these boards exist to get right.
// ─────────────────────────────────────────────────────────────────────────────

import PinnacleScarcityBoardClient, {
  type Row as PinnacleRow,
} from "@/app/insights/pinnacle-scarcity/PinnacleScarcityBoardClient"
import SerialPremiumsBoardClient, {
  type Row as SerialRow,
} from "@/app/insights/serial-premiums/SerialPremiumsBoardClient"

const FETCHED = "2026-08-08T00:00:00Z"

// Route fetch by URL: /api/profile/me for the referral loop, everything else is
// a board refetch. `boardResponse` is swapped per-test to drive success/error.
let boardResponse: { ok: boolean; rows?: unknown[]; status?: number }
let profileUser: { id: string } | null

beforeEach(() => {
  boardResponse = { ok: true, rows: [] }
  profileUser = null
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({ user: profileUser }) } as Response)
      }
      if (!boardResponse.ok) {
        return Promise.resolve({ ok: false, status: boardResponse.status ?? 500 } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          rows: boardResponse.rows ?? [],
          meta: { fetched_at: FETCHED, total_rows: (boardResponse.rows ?? []).length, elapsed_ms: 1 },
        }),
      } as Response)
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── PinnacleScarcity ────────────────────────────────────────────────────────
const pinRows: PinnacleRow[] = [
  {
    render_id: "OEV1-SOUL-JGAR-S2",
    edition_id: "e1",
    character_name: "Joy",
    franchise: "Pixar",
    set_name: "Soul",
    variant_type: "Standard",
    mint_count: 333,
    is_chaser: true, // → CHASER chip
    floor_ask: 12000, // fmtUsd >= 10000 band ($12k, .toFixed(0))
    variant_avg_mint: 1133.7, // Math.round path
    scarcity_vs_variant_pct: 70.4,
    fmv_usd: 4200, // fmtUsd >= 1000 band ($4.2k)
    fmv_confidence: "HIGH",
    image_url: null,
  },
  {
    render_id: "R2",
    edition_id: null,
    character_name: null, // → "—"
    franchise: null,
    set_name: null, // → "—"
    variant_type: null, // → "—"
    mint_count: null, // fmtInt → "—"
    is_chaser: false, // no chip
    floor_ask: 250, // fmtUsd >= 100 band ($250)
    variant_avg_mint: null, // → "—"
    scarcity_vs_variant_pct: null, // fmtPct → "—"
    fmv_usd: 12.5, // fmtUsd < 100 band ($12.50)
    fmv_confidence: null,
    image_url: null,
  },
]

describe("PinnacleScarcityBoardClient — interaction + per-row branches", () => {
  it("renders populated rows across every formatter band + the chaser/null cells", () => {
    const { container } = render(
      <PinnacleScarcityBoardClient initialRows={pinRows} initialFetchedAt={FETCHED} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("Joy")
    expect(text).toContain("CHASER") // is_chaser chip
    expect(text).toContain("$12k") // floor_ask >= 10000
    expect(text).toContain("$4.2k") // fmv_usd >= 1000
    expect(text).toContain("$250") // >= 100
    expect(text).toContain("$12.50") // < 100
    expect(text).toContain("70.4%") // fmtPct
    expect(text).toContain("—") // null cells
  })

  it("refetches with franchise= when a franchise pill is clicked", async () => {
    const { getByText } = render(
      <PinnacleScarcityBoardClient initialRows={pinRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: true, rows: [{ ...pinRows[0], character_name: "Woody" }] }
    fireEvent.click(getByText("Pixar"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("franchise=Pixar"))).toBe(true)
    })
  })

  it("refetches with chasers_only=true when the checkbox is toggled", async () => {
    const { container } = render(
      <PinnacleScarcityBoardClient initialRows={pinRows} initialFetchedAt={FETCHED} />
    )
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("chasers_only=true"))).toBe(true)
    })
  })

  it("refetches when the sort select changes", async () => {
    const { container } = render(
      <PinnacleScarcityBoardClient initialRows={pinRows} initialFetchedAt={FETCHED} />
    )
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "fmv" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=fmv"))).toBe(true)
    })
  })

  it("shows the error state when a refetch returns a non-ok response", async () => {
    const { container, getByText } = render(
      <PinnacleScarcityBoardClient initialRows={pinRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: false, status: 503 }
    fireEvent.click(getByText("Marvel"))
    await waitFor(() => {
      expect((container.textContent ?? "")).toContain("HTTP 503")
    })
  })
})

// ── SerialPremiums ──────────────────────────────────────────────────────────
const serialRows: SerialRow[] = [
  {
    edition_id: "e1",
    external_id: "257:8867",
    player_name: "LeBron James",
    set_name: "Base Set",
    tier: "MOMENT_TIER_LEGENDARY", // normalizeTier strips prefix; tierColor LEGENDARY
    circulation_count: 199,
    thumbnail_url: "https://cdn/thumb1.png",
    moment_id: "m1",
    nft_id: "999", // primaryImg CDN + momentHref
    edition_median_usd: 7.5, // fmtMoney < 100 → $7.50
    premium_multiple: 1200, // fmtMultiple >= 10 → 1,200×
    edition_sales_180d: 42,
    is_conflated: true, // ParallelBadge + conflation note
    headline_serial: 1,
    headline_last_sale_usd: 9000, // fmtMoney >= 100 → $9,000
    headline_sold_at: "2026-07-01T00:00:00Z", // fmtDate valid
  },
  {
    edition_id: null,
    external_id: null, // rowHref → "#"
    player_name: null,
    set_name: "Rare Set",
    tier: "RARE",
    circulation_count: null, // serialLabel without "/ N"
    thumbnail_url: null, // primaryImg null → fallback div
    moment_id: null,
    nft_id: null,
    edition_median_usd: 150, // fmtMoney >= 100
    premium_multiple: 2.5, // fmtMultiple < 10 → 2.5×
    edition_sales_180d: 3,
    is_conflated: false,
    headline_serial: null,
    headline_last_sale_usd: null, // fmtMoney null → "—"
    headline_sold_at: null, // fmtDate null → "—"
  },
]

describe("SerialPremiumsBoardClient — interaction + per-row branches", () => {
  it("renders rows across the multiple/money/tier/conflation branches", async () => {
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("LeBron James")
    expect(text).toContain("1,200×") // premium_multiple >= 10
    expect(text).toContain("2.5×") // < 10
    expect(text).toContain("$7.50") // median < 100
    expect(text).toContain("$9,000") // sale >= 100
    expect(text).toContain("Parallel") // is_conflated → ParallelBadge + note
    expect(text).toContain("LEGENDARY")
    // /api/profile/me fires on mount
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("/api/profile/me"))).toBe(true)
    })
  })

  it("switches to the Perfect Mint board and refetches with headline=perfect", async () => {
    const { getByText } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: true, rows: serialRows }
    fireEvent.click(getByText("Perfect Mint"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("headline=perfect"))).toBe(true)
    })
  })

  it("refetches with tier= when a tier pill is clicked", async () => {
    const { getByText } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: true, rows: serialRows }
    fireEvent.click(getByText("Rare"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("tier=RARE"))).toBe(true)
    })
  })

  it("refetches with window=30d when the window pill is clicked", async () => {
    const { getByText } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: true, rows: serialRows }
    fireEvent.click(getByText("30 days"))
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("window=30d"))).toBe(true)
    })
  })

  it("refetches when the sort select changes", async () => {
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: true, rows: serialRows }
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "recent" } })
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("sort=recent"))).toBe(true)
    })
  })

  it("surfaces the error state on a non-ok refetch", async () => {
    const { container, getByText } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    boardResponse = { ok: false, status: 500 }
    fireEvent.click(getByText("Rare"))
    await waitFor(() => {
      expect((container.textContent ?? "")).toContain("Failed to load")
    })
  })

  it("copies the share link (with ?ref= for a signed-in sharer) via the clipboard", async () => {
    profileUser = { id: "user-42" }
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { getByText } = render(
      <SerialPremiumsBoardClient initialRows={serialRows} initialFetchedAt={FETCHED} />
    )
    // wait for /api/profile/me to resolve so myUserId is set
    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]))
      expect(calls.some((u: string) => u.includes("/api/profile/me"))).toBe(true)
    })
    // ⚠ WAITING FOR THE FETCH TO BE *CALLED* IS NOT WAITING FOR IT TO BE
    // *APPLIED*, and that gap made this test order-dependent: it failed once in
    // a full-suite run and passed in isolation ON THE SAME COMMIT. /api/profile/me
    // had been called, but `setMyUserId` had not flushed, so `copyUrl` was still
    // the anon URL and the first `writeText` carried no `ref=`.
    //
    // `myUserId` has NO rendered signal — it only changes the URL built at click
    // time — so there is nothing to wait ON. Retry the interaction until the
    // state it depends on is live, and assert the LATEST call rather than the
    // first. Re-clicking is side-effect-free here: it re-copies and re-sets
    // `copied`. The button text flips to "Copied!", hence the alternation.
    await waitFor(() => {
      fireEvent.click(getByText(/^(Copy link|Copied!)$/))
      expect(writeText).toHaveBeenCalled()
      expect(String(writeText.mock.calls.at(-1)![0])).toContain("ref=user-42")
    })
    expect(getByText("Copied!")).toBeTruthy()
  })

  it("falls the row image back to the thumbnail, then to the gradient, on error", async () => {
    const { container } = render(
      <SerialPremiumsBoardClient initialRows={[serialRows[0]]} initialFetchedAt={FETCHED} />
    )
    // First <img> uses the nft_id CDN url; error → thumbnail_url; error → fallback div.
    const img = container.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("src")).toContain("assets.nbatopshot.com")
    fireEvent.error(img)
    await waitFor(() => {
      const img2 = container.querySelector("img") as HTMLImageElement
      expect(img2.getAttribute("src")).toBe("https://cdn/thumb1.png")
    })
    fireEvent.error(container.querySelector("img") as HTMLImageElement)
    await waitFor(() => {
      expect(container.querySelector(".rpc-sp-img-fallback")).toBeTruthy()
    })
  })
})
