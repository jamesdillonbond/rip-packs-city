import { describe, it, expect } from "vitest"
import {
  parseIntOrNull,
  buildAliasedQuery,
  extractPartialErrorMsg,
  parseMoments,
  isResolvable,
  editionKey,
  dedupePairs,
  buildEditionOrFilter,
  computeOk,
  type Candidate,
  type GqlMoment,
  type GqlJson,
} from "../workers/topshot-moments-hydrator/parse"

// Unit tests for the topshot-moments-hydrator parse/resolve core. These pin the
// behaviors the worker's own comments call out as the recurring failure class:
//   1. A partial gql-field error (a burned/retired/unknown moment nulling ONLY
//      its own alias) must NOT throw away the other aliases — parseMoments keeps
//      them and the bad one falls through as a graphql_failure.
//   2. A serial of 0 is a sentinel — never resolvable.
//   3. The ok-flag flips red ONLY on a hard chunk failure, or a 0-row write when
//      there WAS resolvable input; degraded-but-honest runs stay ok=true.

function cand(nft_id: string, owner: string | null = null): Candidate {
  return { nft_id, owner_address: owner, source_pack_rip_id: null }
}

describe("parseIntOrNull", () => {
  it("parses numeric strings and numbers to a truncated non-negative int", () => {
    expect(parseIntOrNull("233")).toBe(233)
    expect(parseIntOrNull(8121)).toBe(8121)
    expect(parseIntOrNull("42.9")).toBe(42)
  })
  it("returns null for null/undefined/negative/non-finite/garbage", () => {
    expect(parseIntOrNull(null)).toBeNull()
    expect(parseIntOrNull(undefined)).toBeNull()
    expect(parseIntOrNull(-1)).toBeNull()
    expect(parseIntOrNull("abc")).toBeNull()
    expect(parseIntOrNull(Infinity)).toBeNull()
  })
  it("treats 0 as a valid int (it's the set-flow 0-sentinel, not missing)", () => {
    expect(parseIntOrNull(0)).toBe(0)
    expect(parseIntOrNull("0")).toBe(0)
  })
})

describe("buildAliasedQuery", () => {
  it("emits one aliased getMintedMoment + one ID! var per id", () => {
    const q = buildAliasedQuery(2)
    expect(q).toContain("$id0: ID!")
    expect(q).toContain("$id1: ID!")
    expect(q).toContain("m0: getMintedMoment(momentId: $id0)")
    expect(q).toContain("m1: getMintedMoment(momentId: $id1)")
    // pulls exactly the three fields the resolver needs
    expect(q).toContain("flowSerialNumber")
    expect(q).toContain("... on Play { flowID }")
    expect(q).toContain("... on Set { flowId }")
  })
  it("count 0 → a valid empty query with no aliases", () => {
    const q = buildAliasedQuery(0)
    expect(q).toContain("query Hydrate() {")
    expect(q).not.toContain("getMintedMoment")
  })
})

describe("extractPartialErrorMsg", () => {
  it("returns null when there are no errors", () => {
    expect(extractPartialErrorMsg({ data: {} })).toBeNull()
    expect(extractPartialErrorMsg({ data: {}, errors: [] })).toBeNull()
  })
  it("joins error messages (truncated) for telemetry", () => {
    const msg = extractPartialErrorMsg({ errors: [{ message: "moment 1 not found" }, { message: "moment 2 burned" }] })
    expect(msg).toBe("gql errors: moment 1 not found; moment 2 burned")
  })
  it("tolerates malformed error entries", () => {
    expect(extractPartialErrorMsg({ errors: [null, 42, { nope: 1 }] })).toBe("gql errors: ?; ?; ?")
  })
})

describe("parseMoments — the partial-error survivor", () => {
  const chunk = [cand("A", "0xowner"), cand("B"), cand("C")]

  it("maps present aliases and carries the chunk's owner_address", () => {
    const json: GqlJson = {
      data: {
        m0: { data: { flowSerialNumber: 12, set: { flowId: "233" }, play: { flowID: "8121" } } },
        m1: { data: { flowSerialNumber: 3, set: { flowId: 1 }, play: { flowID: 2 } } },
        m2: { data: { flowSerialNumber: 9, set: { flowId: 5 }, play: { flowID: 6 } } },
      },
    }
    const out = parseMoments(chunk, json)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      nft_id: "A",
      flowSerialNumber: 12,
      set_id_onchain: 233,
      play_id_onchain: 8121,
      owner_address: "0xowner",
    })
    expect(out[1].owner_address).toBeNull()
  })

  it("a null alias (burned/unknown moment) yields null ids but keeps the other rows — NOT discarded", () => {
    const json: GqlJson = {
      data: {
        m0: { data: { flowSerialNumber: 12, set: { flowId: 233 }, play: { flowID: 8121 } } },
        m1: { data: null }, // burned moment nulled its own alias
        // m2 absent entirely
      },
      errors: [{ message: "moment B not found" }],
    }
    const out = parseMoments(chunk, json)
    expect(out).toHaveLength(3)
    expect(out[0].set_id_onchain).toBe(233) // good alias survives
    expect(out[1]).toMatchObject({ nft_id: "B", flowSerialNumber: null, set_id_onchain: null, play_id_onchain: null })
    expect(out[2]).toMatchObject({ nft_id: "C", set_id_onchain: null }) // missing alias → null ids, not dropped
  })

  it("missing data block entirely → all null-id rows (never throws)", () => {
    const out = parseMoments(chunk, {})
    expect(out).toHaveLength(3)
    expect(out.every((m) => m.set_id_onchain === null)).toBe(true)
  })
})

describe("isResolvable", () => {
  const base: GqlMoment = { nft_id: "x", flowSerialNumber: 5, set_id_onchain: 1, play_id_onchain: 2, owner_address: null }
  it("resolvable when serial>0 and both on-chain ids present", () => {
    expect(isResolvable(base)).toBe(true)
  })
  it("serial 0 is a sentinel → not resolvable", () => {
    expect(isResolvable({ ...base, flowSerialNumber: 0 })).toBe(false)
  })
  it("null serial or missing set/play → not resolvable", () => {
    expect(isResolvable({ ...base, flowSerialNumber: null })).toBe(false)
    expect(isResolvable({ ...base, set_id_onchain: null })).toBe(false)
    expect(isResolvable({ ...base, play_id_onchain: null })).toBe(false)
  })
  it("a set_id_onchain of 0 is still valid (parallel 0-sentinel)", () => {
    expect(isResolvable({ ...base, set_id_onchain: 0 })).toBe(true)
  })
})

describe("editionKey + dedupePairs + buildEditionOrFilter", () => {
  it("editionKey builds the canonical set:play string", () => {
    expect(editionKey(233, 8121)).toBe("233:8121")
    expect(editionKey(0, 5)).toBe("0:5")
  })
  it("dedupePairs collapses repeated editions, keeps distinct ones", () => {
    const uniq = dedupePairs([
      { set_id_onchain: 1, play_id_onchain: 2 },
      { set_id_onchain: 1, play_id_onchain: 2 },
      { set_id_onchain: 3, play_id_onchain: 4 },
    ])
    expect(uniq).toHaveLength(2)
    expect(uniq.map((p) => editionKey(p.set_id_onchain, p.play_id_onchain)).sort()).toEqual(["1:2", "3:4"])
  })
  it("buildEditionOrFilter emits one and(...) term per DISTINCT pair", () => {
    const f = buildEditionOrFilter([
      { set_id_onchain: 1, play_id_onchain: 2 },
      { set_id_onchain: 1, play_id_onchain: 2 },
      { set_id_onchain: 3, play_id_onchain: 4 },
    ])
    expect(f).toBe("and(set_id_onchain.eq.1,play_id_onchain.eq.2),and(set_id_onchain.eq.3,play_id_onchain.eq.4)")
  })
  it("empty pairs → empty filter", () => {
    expect(buildEditionOrFilter([])).toBe("")
  })
})

describe("computeOk — ok-flag policy", () => {
  it("ok when a write landed rows", () => {
    expect(computeOk(0, 42, 100)).toBe(true)
  })
  it("ok when nothing was resolvable (honest degraded run, not a failure)", () => {
    expect(computeOk(0, 0, 0)).toBe(true)
  })
  it("NOT ok when we had resolvable input but wrote 0 rows", () => {
    expect(computeOk(0, 0, 100)).toBe(false)
  })
  it("NOT ok on any hard chunk failure regardless of writes", () => {
    expect(computeOk(1, 42, 100)).toBe(false)
    expect(computeOk(2, 0, 0)).toBe(false)
  })
})
