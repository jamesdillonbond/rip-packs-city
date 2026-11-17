import { describe, it, expect, vi } from "vitest"
import {
  readCanonicalBadgeTitles,
  filterRowsByBadges,
  CANONICAL_BADGE_CHUNK,
} from "@/lib/market/canonical-badges"

// Unit tests for the market's canonical-badge read (R104, 2026-10-13). The
// properties pinned here are the ones whose failure would publish a false
// answer: a failed read must never come back as an empty map, and a partial
// read (one chunk failing) must never come back as a map either.

type Resp = { data: unknown; error: unknown }
function client(responder: (args: { p_collection_id: string; p_route_slugs: string[] }) => Resp) {
  const rpc = vi.fn(async (fn: string, args: { p_collection_id: string; p_route_slugs: string[] }) => {
    expect(fn).toBe("get_edition_badge_titles")
    return responder(args)
  })
  return { supa: { rpc } as never, rpc }
}

describe("readCanonicalBadgeTitles", () => {
  it("returns the titles keyed by edition external_id", async () => {
    const { supa } = client(() => ({ data: { "39:1269": ["Championship Year"], "39:1275": [] }, error: null }))
    const r = await readCanonicalBadgeTitles(supa, "c", ["39:1269", "39:1275"])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.titles.get("39:1269")).toEqual(["Championship Year"])
    expect(r.titles.get("39:1275")).toEqual([])
  })

  it("drops null/blank keys and duplicates before calling, and makes NO call when nothing is left", async () => {
    const { supa, rpc } = client((a) => ({ data: Object.fromEntries(a.p_route_slugs.map((k) => [k, []])), error: null }))
    await readCanonicalBadgeTitles(supa, "c", ["a", "a", null, undefined, "", "  ", "b"])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1].p_route_slugs).toEqual(["a", "b"])

    const empty = client(() => ({ data: {}, error: null }))
    const r = await readCanonicalBadgeTitles(empty.supa, "c", [null, ""])
    expect(empty.rpc).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it("chunks at the function's 500-slug cap, so a 1,000-row window is fully read", async () => {
    expect(CANONICAL_BADGE_CHUNK).toBe(500)
    const keys = Array.from({ length: 1001 }, (_, i) => `k${i}`)
    const { supa, rpc } = client((a) => ({
      data: Object.fromEntries(a.p_route_slugs.map((k) => [k, ["Rookie Year"]])),
      error: null,
    }))
    const r = await readCanonicalBadgeTitles(supa, "c", keys)
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls.every((c) => c[1].p_route_slugs.length <= 500)).toBe(true)
    expect(r.ok && r.titles.size).toBe(1001)
  })

  it("a failed read is ok:false, NOT an empty map", async () => {
    const { supa } = client(() => ({ data: null, error: { message: "canceling statement due to statement timeout" } }))
    const r = await readCanonicalBadgeTitles(supa, "c", ["a"])
    expect(r).toEqual({ ok: false, error: "canceling statement due to statement timeout" })
  })

  it("ONE failed chunk fails the whole read — a partial map would show 'no badges' on that chunk's rows", async () => {
    const keys = Array.from({ length: 600 }, (_, i) => `k${i}`)
    const { supa } = client((a) =>
      a.p_route_slugs.includes("k550")
        ? { data: null, error: { message: "boom" } }
        : { data: Object.fromEntries(a.p_route_slugs.map((k) => [k, ["Rookie Year"]])), error: null },
    )
    const r = await readCanonicalBadgeTitles(supa, "c", keys)
    expect(r.ok).toBe(false)
  })

  it("a non-object payload (array / null) is a contract break, not 'no badges'", async () => {
    for (const data of [[], null, "x"]) {
      const { supa } = client(() => ({ data, error: null }))
      const r = await readCanonicalBadgeTitles(supa, "c", ["a"])
      expect(r.ok, JSON.stringify(data)).toBe(false)
    }
  })

  it("an error with no message still yields a non-empty error string", async () => {
    const { supa } = client(() => ({ data: null, error: { code: "PGRST000" } }))
    const r = await readCanonicalBadgeTitles(supa, "c", ["a"])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe("PGRST000")
  })

  it("ignores non-string titles and blank strings inside a value", async () => {
    const { supa } = client(() => ({ data: { a: ["Rookie Year", "", null, 3, " "] }, error: null }))
    const r = await readCanonicalBadgeTitles(supa, "c", ["a"])
    expect(r.ok && r.titles.get("a")).toEqual(["Rookie Year"])
  })
})

describe("filterRowsByBadges", () => {
  const rows = [
    { id: 1, badgeSlugs: ["Rookie Year"] },
    { id: 2, badgeSlugs: ["Championship Year", "Rookie Mint"] },
    { id: 3, badgeSlugs: [] as string[] },
  ]
  it("keeps rows carrying ANY selected badge", () => {
    expect(filterRowsByBadges(rows, ["Rookie Mint", "Rookie Year"], true).map((r) => r.id)).toEqual([1, 2])
  })
  it("hasBadges alone keeps every badged row", () => {
    expect(filterRowsByBadges(rows, [], true).map((r) => r.id)).toEqual([1, 2])
  })
  it("no filter returns the rows unchanged", () => {
    expect(filterRowsByBadges(rows, [], false)).toBe(rows)
  })
  it("a badge nobody carries yields none (the honest answer over a clean read)", () => {
    expect(filterRowsByBadges(rows, ["Hall of Fame"], true)).toEqual([])
  })
})
