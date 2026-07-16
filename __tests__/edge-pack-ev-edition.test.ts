import { describe, it, expect } from "vitest"
import {
  editionExtKey,
  normalizeTier,
  mergePackPoolNodes,
  type EditionNode,
} from "@/supabase/functions/_shared/pack-ev-edition"

// Unit tests for the Top Shot pack-EV edition keying + tier normalization,
// extracted from compute-topshot-pack-ev/index.ts. These pin the v20 invariant
// that the resolve set and the pool rows key an edition identically — a divergence
// here silently drops editions out of the EV pool.

function node(
  set: { id: string; flowId?: number | string | null } | null,
  play: { id: string; flowID?: number | string | null } | null,
  tier = "COMMON",
): EditionNode {
  return { count: 1, remaining: 1, edition: { id: "ed-uuid", tier, set, play } }
}

describe("editionExtKey — int pair is preferred, UUID pair is the fallback", () => {
  it("keys on the on-chain int pair when both set.flowId and play.flowID are present", () => {
    const r = editionExtKey(node({ id: "set-uuid", flowId: 233 }, { id: "play-uuid", flowID: 8121 }))
    expect(r).toEqual({ ext: "233:8121", intPair: true })
  })

  it("coerces numeric-string flow ids to numbers in the key (no quotes, no leading zeros)", () => {
    const r = editionExtKey(node({ id: "s", flowId: "0233" }, { id: "p", flowID: "8121" }))
    expect(r).toEqual({ ext: "233:8121", intPair: true })
  })

  it("falls back to the UUID pair when the set int is missing", () => {
    const r = editionExtKey(node({ id: "set-uuid", flowId: null }, { id: "play-uuid", flowID: 8121 }))
    expect(r).toEqual({ ext: "set-uuid:play-uuid", intPair: false })
  })

  it("falls back to the UUID pair when the play int is missing", () => {
    const r = editionExtKey(node({ id: "set-uuid", flowId: 233 }, { id: "play-uuid", flowID: undefined }))
    expect(r).toEqual({ ext: "set-uuid:play-uuid", intPair: false })
  })

  it("falls back to the UUID pair when a flow id is present but not finite", () => {
    const r = editionExtKey(node({ id: "set-uuid", flowId: "abc" }, { id: "play-uuid", flowID: 8121 }))
    expect(r).toEqual({ ext: "set-uuid:play-uuid", intPair: false })
  })

  it("treats flowId 0 as a present, finite int (0-sentinel sub rows still int-key)", () => {
    // set.flowId is a 0-sentinel on parallel/sub rows — it must still int-pair.
    const r = editionExtKey(node({ id: "s", flowId: 0 }, { id: "p", flowID: 8121 }))
    expect(r).toEqual({ ext: "0:8121", intPair: true })
  })

  it("returns a null key when neither int pair nor full UUID pair is available", () => {
    expect(editionExtKey(node(null, { id: "p", flowID: null }))).toEqual({ ext: null, intPair: false })
    expect(editionExtKey(node({ id: "", flowId: null }, { id: "", flowID: null }))).toEqual({
      ext: null,
      intPair: false,
    })
  })
})

describe("normalizeTier — canonical Top Shot buckets, unknown → null", () => {
  it.each([
    ["ULTIMATE", "ULTIMATE"],
    ["LEGENDARY", "LEGENDARY"],
    ["RARE", "RARE"],
    ["FANDOM", "FANDOM"],
    ["COMMON", "COMMON"],
  ])("maps a plain tier %s to %s", (raw, expected) => {
    expect(normalizeTier(raw)).toBe(expected)
  })

  it("is case-insensitive and matches the MOMENT_TIER_* wire spellings by substring", () => {
    expect(normalizeTier("moment_tier_legendary")).toBe("LEGENDARY")
    expect(normalizeTier("Ultimate")).toBe("ULTIMATE")
    expect(normalizeTier("MOMENT_TIER_COMMON")).toBe("COMMON")
  })

  it("returns null for a nullish or empty tier", () => {
    expect(normalizeTier(null)).toBeNull()
    expect(normalizeTier(undefined)).toBeNull()
    expect(normalizeTier("")).toBeNull()
  })

  it("returns null for a tier outside the Top Shot vocabulary", () => {
    // UFC/other tiers are not Top Shot pack-EV buckets — must not be coerced.
    expect(normalizeTier("CHALLENGER")).toBeNull()
    expect(normalizeTier("CONTENDER")).toBeNull()
  })

  it("substring-matches, so 'UNCOMMON' collapses into COMMON (pinned quirk)", () => {
    // The matcher is a substring test: 'UNCOMMON'.includes('COMMON') is true.
    // Top Shot never emits UNCOMMON so this is harmless in practice, but the
    // behavior is pinned here so a future refactor to exact-match is a conscious,
    // test-visible change rather than a silent one.
    expect(normalizeTier("UNCOMMON")).toBe("COMMON")
  })
})

describe("mergePackPoolNodes — v22 per-slot dedup + weight", () => {
  // A node carrying an int pair (set.flowId:play.flowID) plus a draw count/remaining.
  function poolNode(setFlow: number, playFlow: number, count: number, remaining: number): EditionNode {
    return {
      count,
      remaining,
      edition: { id: "ed", tier: "COMMON", set: { id: "s", flowId: setFlow }, play: { id: "p", flowID: playFlow } },
    }
  }
  // resolve every ext key to `ed-<ext>` unless it's in the missing set.
  const resolver = (missing: Set<string> = new Set()) => (ext: string) =>
    missing.has(ext) ? undefined : `ed-${ext}`

  it("sums count + remaining across duplicate slot nodes of the same edition", () => {
    const rows = mergePackPoolNodes(
      [poolNode(1, 2, 5, 3), poolNode(1, 2, 4, 1)],
      resolver(),
      100,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].editionId).toBe("ed-1:2")
    expect(rows[0].origDropWeight).toBe(9) // 5 + 4
    expect(rows[0].dropWeight).toBeCloseTo(4 / 100, 6) // (3 + 1) / totalUnopened
  })

  it("keeps distinct editions as separate rows", () => {
    const rows = mergePackPoolNodes([poolNode(1, 2, 1, 1), poolNode(3, 4, 2, 2)], resolver(), 10)
    expect(rows.map((r) => r.editionFlowId).sort()).toEqual(["1:2", "3:4"])
  })

  it("drops nodes that don't resolve to a known edition", () => {
    const rows = mergePackPoolNodes([poolNode(1, 2, 1, 1)], resolver(new Set(["1:2"])), 10)
    expect(rows).toEqual([])
  })

  it("drops un-keyable nodes (no int pair, no full UUID pair)", () => {
    const bad: EditionNode = { count: 1, remaining: 1, edition: { id: "e", tier: "COMMON", set: null, play: null } }
    expect(mergePackPoolNodes([bad], resolver(), 10)).toEqual([])
  })

  it("weights to 0 when totalUnopened is non-positive (never divides by zero)", () => {
    const rows = mergePackPoolNodes([poolNode(1, 2, 3, 3)], resolver(), 0)
    expect(rows[0].dropWeight).toBe(0)
    expect(rows[0].origDropWeight).toBe(3) // original count still reported
  })

  it("treats missing count/remaining as 0", () => {
    const partial = { edition: { id: "e", tier: "COMMON", set: { id: "s", flowId: 7 }, play: { id: "p", flowID: 8 } } } as unknown as EditionNode
    const rows = mergePackPoolNodes([partial], resolver(), 10)
    expect(rows[0].origDropWeight).toBe(0)
    expect(rows[0].dropWeight).toBe(0)
  })
})
