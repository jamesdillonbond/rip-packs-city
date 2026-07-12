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

import { fetchBadgeArt } from "@/lib/badges/server-art"

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
