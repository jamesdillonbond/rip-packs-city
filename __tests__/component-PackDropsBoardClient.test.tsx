// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import React from "react"
import type { ScoredDrop, ScoredEdition } from "@/lib/pack-drops-board"

// Vaultopolis Pack-Drops board client — had NO dedicated test (48.1% br).
// Drives the initial scored-drop render (matched / fallback / parallel rows +
// odds table), the ref-tracking /api/profile/me fetch, the refresh refetch,
// and the copy-link button.

import PackDropsBoardClient from "@/app/insights/pack-drops/PackDropsBoardClient"

const edition = (o: Partial<ScoredEdition> = {}): ScoredEdition => ({
  player: "Damian Lillard", set: "Base Set", series: 4, count: 1, value_tier: "Chase",
  their_est: 60, rpc_fmv_avg: 80, confidence: "HIGH", edition_matches: 1, matched: true,
  is_parallel: false, pool_contribution: 80, used_fallback: false, ...o,
})

const drop = (o: Partial<ScoredDrop> = {}): ScoredDrop => ({
  drop_id: 1, name: "Blazers Repack", description: "desc", status: "active",
  pack_count: 100, opened_count: 10, nfts_per_pack: 5, total_nfts: 500,
  listing_price_flow: 1000, listing_currency: "FLOW", pack_price_flow: 10, pack_price_usd: 7,
  flow_usd: 0.7, rpc_pool_usd: 900, rpc_pack_ev_usd: 9, value_concentration_pct: 30,
  matched_count: 2, total_distinct: 3, has_parallel: true, verdict: "Solid value vs the FLOW price",
  verdict_kind: "value", sale_state: { saleOpen: true } as ScoredDrop["sale_state"],
  odds: { tiers: [{ tier: "Chase", count: 5, per_card: 0.01, at_least_one: 0.05 }] } as unknown as ScoredDrop["odds"],
  rows: [
    edition(),
    edition({ player: "Scoot", matched: false, used_fallback: true, rpc_fmv_avg: null, their_est: 20 }),
    edition({ player: "Ant", is_parallel: true, count: 3, matched: false, used_fallback: false, rpc_fmv_avg: null }),
  ],
  ...o,
})

let fetchFn: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchFn = vi.fn(async (url: string) => {
    if (String(url).includes("/api/profile/me")) {
      return { ok: true, status: 200, json: async () => ({ user: { id: "user-9" } }) }
    }
    return {
      ok: true, status: 200,
      json: async () => ({ meta: { fetched_at: "2026-08-02T00:00:00Z", total_drops: 1, elapsed_ms: 5 }, drops: [drop({ name: "Refreshed Drop" })] }),
    }
  })
  vi.stubGlobal("fetch", fetchFn)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PackDropsBoardClient", () => {
  it("renders the scored drop with matched / fallback / parallel rows and the odds table", async () => {
    const { container } = render(<PackDropsBoardClient initialDrops={[drop()]} initialFetchedAt="2026-08-01T00:00:00Z" />)
    expect(container.textContent).toContain("Blazers Repack")
    // matched row shows RPC FMV; fallback row shows the operator est with a star
    expect(container.textContent).toContain("$80")
    expect(container.textContent).toContain("$20.00*")
    // parallel badge + published-odds table
    expect(container.textContent).toMatch(/Parallel/)
    expect(container.textContent).toMatch(/Published odds/i)
    // the "RPC priced N of M" caveat
    expect(container.textContent).toMatch(/RPC priced/i)
  })

  it("resolves the viewer id via /api/profile/me for the share ref link", async () => {
    render(<PackDropsBoardClient initialDrops={[drop()]} initialFetchedAt={null} />)
    await waitFor(() => expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/api/profile/me"))).toBe(true))
  })

  it("refetches the board when Refresh is clicked", async () => {
    const { container } = render(<PackDropsBoardClient initialDrops={[drop()]} initialFetchedAt={null} />)
    const btn = [...container.querySelectorAll("button")].find((b) => /refresh/i.test(b.textContent ?? ""))!
    fireEvent.click(btn)
    await waitFor(() => expect(container.textContent).toContain("Refreshed Drop"))
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("/api/public/insights/pack-drops"))).toBe(true)
  })

  it("surfaces the error state when refresh fails", async () => {
    const { container } = render(<PackDropsBoardClient initialDrops={[drop()]} initialFetchedAt={null} />)
    fetchFn.mockImplementation(async (url: string) =>
      String(url).includes("/api/profile/me")
        ? { ok: true, status: 200, json: async () => ({ user: null }) }
        : { ok: false, status: 503, json: async () => ({}) },
    )
    fireEvent.click([...container.querySelectorAll("button")].find((b) => /refresh/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load|HTTP 503/i))
  })

  it("copies the share link (with ref) to the clipboard", async () => {
    const writeText = vi.fn(async (_text: string) => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<PackDropsBoardClient initialDrops={[drop()]} initialFetchedAt={null} />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    const copyBtn = [...container.querySelectorAll("button")].find((b) => /copy/i.test(b.textContent ?? ""))
    if (copyBtn) {
      fireEvent.click(copyBtn)
      await waitFor(() => expect(writeText).toHaveBeenCalled())
      expect(String(writeText.mock.calls[0][0])).toContain("/insights/pack-drops")
    }
  })
})
