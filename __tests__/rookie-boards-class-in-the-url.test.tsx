// @vitest-environment jsdom
// The rookie boards' class lives in the URL (2026-10-23). Both boards gained a
// 2025 / 2026 CLASS tab on 10-22 as client state; their APIs honoured ?class=
// but the PAGES did not, so the 2026 class had no shareable link and
// /insights/rookie-board?class=2026 rendered the 2025 default. Now the client
// reads the tab from the page URL (an external store) and the share URL carries the
// class back out; the default class keeps the bare (canonical) URL.

import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { DEFAULT_ROOKIE_CLASS, readRookieClassParam, rookieBoardShareUrl } from "@/lib/rookie-class-link"
import { normalizeRow } from "@/lib/rookie-edition-board"
import RookieBoardClient from "@/app/insights/rookie-board/RookieBoardClient"
import RookiesBoardClient, { type ApiResponse } from "@/app/insights/rookies/RookiesBoardClient"

const CLASSES = ["2025", "2026"] as const

function setSearch(search: string) {
  window.history.replaceState({}, "", `/insights/rookie-board${search}`)
}

afterEach(() => {
  cleanup()
  setSearch("")
  vi.unstubAllGlobals()
})

describe("readRookieClassParam", () => {
  it("returns a class the board knows, and null for absent, unknown or unparsable input", () => {
    expect(readRookieClassParam("?class=2026", CLASSES)).toBe("2026")
    expect(readRookieClassParam("?sort=gmv&class=2025", CLASSES)).toBe("2025")
    expect(readRookieClassParam("", CLASSES)).toBeNull()
    expect(readRookieClassParam("?class=2027", CLASSES)).toBeNull()
    expect(readRookieClassParam("?class=", CLASSES)).toBeNull()
    // never throws, whatever the input
    expect(readRookieClassParam(undefined as unknown as string, CLASSES)).toBeNull()
  })
})

describe("rookieBoardShareUrl", () => {
  it("is the bare canonical URL for the default class and carries any other class", () => {
    expect(DEFAULT_ROOKIE_CLASS).toBe("2025")
    expect(rookieBoardShareUrl("https://x.test/insights/rookie-board", "2025")).toBe("https://x.test/insights/rookie-board")
    expect(rookieBoardShareUrl("https://x.test/insights/rookie-board", "2026")).toBe("https://x.test/insights/rookie-board?class=2026")
  })
})

describe("Rookie Board (by parallel): the class in the URL", () => {
  const row = (player_name: string, rookie_class: string | null) =>
    normalizeRow({
      player_name, rookie_class, set_name: "Rookie Debut", tier: "COMMON", parallel_id: 0,
      parallel_name: "Standard", external_id: `${player_name}:1`, circulation_count: 500,
      fmv_usd: 100, has_full_economics: true,
    })
  const rows = [row("Cooper Flagg", "2025"), row("Darryn Peterson", "2026")]

  it("?class=2026 on the page URL opens the 2026 tab, and the share link carries it", async () => {
    setSearch("?class=2026")
    const { getAllByText, queryAllByText, container } = render(
      <RookieBoardClient initialRows={rows} initialFetchedAt="2026-10-23T05:00:00Z" />,
    )
    await waitFor(() => expect(getAllByText(/Darryn Peterson/).length).toBeGreaterThan(0))
    expect(queryAllByText(/Cooper Flagg/)).toHaveLength(0)
    const tweet = container.querySelector('a[href*="twitter.com/intent/tweet"]') as HTMLAnchorElement | null
    expect(tweet).not.toBeNull()
    expect(decodeURIComponent(tweet!.href)).toContain("/insights/rookie-board?class=2026")
  })

  it("CONTROL: no class in the URL keeps the 2025 default and the bare share link", async () => {
    setSearch("?class=2027")
    const { getAllByText, queryAllByText, container } = render(
      <RookieBoardClient initialRows={rows} initialFetchedAt="2026-10-23T05:00:00Z" />,
    )
    await waitFor(() => expect(getAllByText(/Cooper Flagg/).length).toBeGreaterThan(0))
    expect(queryAllByText(/Darryn Peterson/)).toHaveLength(0)
    const tweet = container.querySelector('a[href*="twitter.com/intent/tweet"]') as HTMLAnchorElement | null
    expect(decodeURIComponent(tweet!.href)).toContain("/insights/rookie-board")
    expect(decodeURIComponent(tweet!.href)).not.toContain("class=")
  })
})

describe("Rookie Index: the class in the URL", () => {
  const row = (player_name: string) => ({
    player_name, edition_count: 4, sales_30d: 1, gmv_30d: 75, avg_price_30d: 75, max_sale_30d: 75,
    total_locked: 0, total_burned: 0, total_circ: 654, cohort_squeeze_pct: 0, avg_lock_rate_pct: 0,
    mint_one_eds_with_history: 0, max_mint_one_sale_usd: null,
  })
  const stats = { rookie_count: 1, total_sales_30d: 1, total_gmv_30d: 75, avg_price_active: 75, rookies_with_activity_30d: 1, rookies_with_mint_one_sale: 0, top_mint_one_sale: null }
  const initial: ApiResponse = {
    meta: { fetched_at: "2026-10-23T05:00:00Z" },
    cohort_stats: stats,
    rows: [row("Cooper Flagg")],
    class_2026: { cohort_stats: stats, rows: [row("Darryn Peterson")] },
  }

  it("?class=2026 opens the 2026 class from the seed (no refetch) and the share link carries it", async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    vi.stubGlobal("fetch", fetchSpy)
    setSearch("?class=2026")
    const { getAllByText, queryByText, container } = render(<RookiesBoardClient initial={initial} />)
    await waitFor(() => expect(getAllByText("Darryn Peterson").length).toBeGreaterThan(0))
    expect(queryByText("Cooper Flagg")).toBeNull()
    expect(fetchSpy.mock.calls.some((c: any[]) => String(c[0]).includes("/api/public/insights/rookies"))).toBe(false)
    const tweet = container.querySelector('a[href*="twitter.com/intent/tweet"]') as HTMLAnchorElement | null
    expect(tweet).not.toBeNull()
    expect(decodeURIComponent(tweet!.href)).toContain("/insights/rookies?class=2026")
  })
})

describe("source pins — both clients seed from the URL and share the class", () => {
  for (const file of ["app/insights/rookie-board/RookieBoardClient.tsx", "app/insights/rookies/RookiesBoardClient.tsx"]) {
    it(`${file} reads the URL class through useRookieClassParam (an external store, never setState in an effect) and builds its share URL with rookieBoardShareUrl`, () => {
      const src = stripComments(readFileSync(file, "utf8"))
      expect(src).toMatch(/useRookieClassParam\(/)
      expect(src).toMatch(/rookieBoardShareUrl\(/)
      // never the server's searchParams (the page is ISR), never useSearchParams
      // (needs a Suspense boundary), never window.location in the component itself
      // (the hooks ratchet bans setState-in-effect, which is how that reads)
      expect(src).not.toMatch(/useSearchParams/)
      expect(src).not.toMatch(/window\.location/)
    })
  }
})
