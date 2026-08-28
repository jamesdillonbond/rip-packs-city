import { describe, it, expect, beforeEach, vi } from "vitest"

// Pins lib/badges/server-art.ts — the server-side badge-artwork resolver. It
// calls get_badge_display_metadata and returns a normalized-title -> icon_url
// Map, so we stub supabaseAdmin.rpc and assert: the empty/all-falsy short
// circuit (no RPC), de-dup + collectionId param mapping, the normalizeBadgeKey
// keying, entries with a missing icon_url being skipped, and both the
// rpc-error and thrown-exception paths degrading to an empty Map.

const state: { rpc: (name: string, args: any) => any } = {
  rpc: async () => ({ data: {}, error: null }),
}

vi.mock("@/lib/supabase", () => {
  const client: any = { rpc: (name: string, args: any) => state.rpc(name, args) }
  return { supabase: client, supabaseAdmin: client }
})

import { fetchBadgeArt, BADGE_ART_TIMEOUT_MS } from "@/lib/badges/server-art"
import { DEFAULT_RPC_TIMEOUT_MS } from "@/lib/analytics/rpc-with-retry"

beforeEach(() => {
  state.rpc = async () => ({ data: {}, error: null })
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("fetchBadgeArt", () => {
  it("short-circuits to an empty Map (no RPC) for empty or all-falsy titles", async () => {
    const spy = vi.fn(async () => ({ data: {}, error: null }))
    state.rpc = spy
    expect((await fetchBadgeArt([])).size).toBe(0)
    expect((await fetchBadgeArt(["", ""])).size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it("de-dupes titles and forwards collectionId (null default) to the RPC", async () => {
    let seenName: any = null
    let seen: any = null
    state.rpc = async (name, args) => {
      seenName = name
      seen = args
      return { data: {}, error: null }
    }
    await fetchBadgeArt(["Rookie Year", "Rookie Year", "MVP"])
    expect(seenName).toBe("get_badge_display_metadata")
    expect(seen.p_titles).toEqual(["Rookie Year", "MVP"])
    expect(seen.p_collection_id).toBeNull()

    await fetchBadgeArt(["MVP"], "coll-123")
    expect(seen.p_collection_id).toBe("coll-123")
  })

  it("maps canonical titles to normalized keys and skips entries with no icon_url", async () => {
    state.rpc = async () => ({
      data: {
        "Rookie Year": { icon_url: "https://x/rookie.svg" },
        "Championship Year": { icon_url: null }, // skipped — no art
        "MVP": {}, // skipped — missing field
      },
      error: null,
    })
    const map = await fetchBadgeArt(["Rookie Year", "Championship Year", "MVP"])
    expect(map.get("rookieyear")).toBe("https://x/rookie.svg")
    expect(map.has("championshipyear")).toBe(false)
    expect(map.has("mvp")).toBe(false)
    expect(map.size).toBe(1)
  })

  it("returns an empty Map (and warns) on an RPC error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    state.rpc = async () => ({ data: null, error: { message: "rpc down" } })
    expect((await fetchBadgeArt(["MVP"])).size).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it("returns an empty Map (and warns) when the RPC throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    state.rpc = async () => {
      throw new Error("network")
    }
    expect((await fetchBadgeArt(["MVP"])).size).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  it("tolerates a non-object data payload without throwing", async () => {
    state.rpc = async () => ({ data: null, error: null })
    expect((await fetchBadgeArt(["MVP"])).size).toBe(0)
  })
})

// ── The page-blocking budget ────────────────────────────────────────────────
// Regression pin for the 2026-08-28 fix. This read is the LAST sequential await
// on /moment/[id] and sits in the shell Promise.all on the edition page, so its
// budget is a user-visible ceiling: until it settles, the visitor sees only the
// route's "SCANNING THE MARKETPLACE…" fallback.
//
// It was routed through rpcWithRetry for a bound in 2026-08-13 but given no
// `timeoutMs`, so it silently inherited DEFAULT_RPC_TIMEOUT_MS (45s) — 71% of
// the moment page's 63.5s worst case, on a page whose every other read is
// bounded at 2.5–8s.
//
// ⚠ These assert the BEHAVIOUR (a hung RPC settles inside the budget), not the
// literal number, so re-tuning BADGE_ART_TIMEOUT_MS keeps them green while
// DELETING the `timeoutMs` argument — the actual defect — turns them red.
describe("fetchBadgeArt page-blocking budget", () => {
  it("gives up on a hung RPC within its own budget, degrading to an empty Map", async () => {
    vi.useFakeTimers()
    try {
      // Never resolves — the failure DB saturation actually produces. A read
      // that is merely SLOW errors nowhere, so neither the error branch nor the
      // catch is reachable without a bound.
      state.rpc = () => new Promise(() => {})
      const p = fetchBadgeArt(["MVP"])
      let settled = false
      void p.then(() => {
        settled = true
      })

      // Just under the budget: still waiting.
      await vi.advanceTimersByTimeAsync(BADGE_ART_TIMEOUT_MS - 1)
      expect(settled).toBe(false)

      // Past it: the bound fires, lands in the existing catch, empty Map.
      await vi.advanceTimersByTimeAsync(BADGE_ART_TIMEOUT_MS)
      expect(settled).toBe(true)
      expect((await p).size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("is bounded far tighter than the rpcWithRetry default it would otherwise inherit", () => {
    // The defect was inheritance, not the absence of any bound at all — so the
    // property worth pinning is that this caller states a page-appropriate
    // budget rather than accepting the batch-job default.
    expect(BADGE_ART_TIMEOUT_MS).toBeLessThan(DEFAULT_RPC_TIMEOUT_MS)
    // Sized off the observed success band: 39,286 production calls of
    // get_badge_display_metadata read mean 47ms / max 2,292ms. Anything at or
    // below that max would truncate runs that were going to succeed.
    expect(BADGE_ART_TIMEOUT_MS).toBeGreaterThan(2_292)
  })
})
