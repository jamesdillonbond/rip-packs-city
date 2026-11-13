import { describe, it, expect, vi } from "vitest"

// lib/candy/edition-rarity-label.ts — Candy's OWN rarity name on the edition page (2026-11-13).
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/api/bounded-read", () => ({ apiReadTimeoutMs: () => 5_000 }))
vi.mock("@/lib/analytics/rpc-with-retry", () => ({ withQueryDeadline: async (p: any) => p }))

import { fetchCandyRarityLabel, nativeRarityChipText } from "@/lib/candy/edition-rarity-label"

function db(result: { data: any; error: any }) {
  const calls: any[] = []
  const q: any = {
    select: (c: string) => { calls.push(["select", c]); return q },
    eq: (c: string, v: string) => { calls.push(["eq", c, v]); return q },
    limit: async () => result,
  }
  return { from: (t: string) => { calls.push(["from", t]); return q }, calls }
}

describe("nativeRarityChipText", () => {
  it("shows Candy's name when it says something the tier badge does not", () => {
    expect(nativeRarityChipText("Titan", "LEGENDARY")).toBe("Titan")
    expect(nativeRarityChipText("Core", "COMMON")).toBe("Core")
    expect(nativeRarityChipText("Unique", null)).toBe("Unique")
  })
  it("omits it when it only repeats the tier, and when there is no label", () => {
    expect(nativeRarityChipText("Legendary", "LEGENDARY")).toBeNull()
    expect(nativeRarityChipText("Epic", "EPIC")).toBeNull()
    expect(nativeRarityChipText(null, "RARE")).toBeNull()
    expect(nativeRarityChipText("  ", null)).toBeNull()
  })
})

describe("fetchCandyRarityLabel", () => {
  it("reads the label from the Candy edition row", async () => {
    const d = db({ data: [{ rarity_label: "Titan" }], error: null })
    expect(await fetchCandyRarityLabel("ed1", d)).toEqual({ ok: true, label: "Titan" })
    expect(d.calls).toContainEqual(["eq", "collection_id", "209ade70-32c5-4470-bc7c-4793d660f713"])
    expect(d.calls).toContainEqual(["eq", "id", "ed1"])
  })
  it("a row with no label is ok:true and null — no chip, not a failure", async () => {
    expect(await fetchCandyRarityLabel("ed1", db({ data: [{ rarity_label: null }], error: null }))).toEqual({ ok: true, label: null })
  })
  it("a FAILED read is ok:false and null — the page renders nothing, never a guessed name", async () => {
    expect(await fetchCandyRarityLabel("ed1", db({ data: null, error: { message: "timeout" } }))).toEqual({ ok: false, label: null })
  })
})
