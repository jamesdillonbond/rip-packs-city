// Signed editions (editions.autographed_at, from Atlas autographedAt — migration
// 20261020030228). Every helper here makes POSITIVE claims only, and every
// failed read is reported as a failure, never as "nothing is signed".

import { describe, it, expect } from "vitest"
import {
  AUTOGRAPH_BADGE_SLUG,
  allDayPairKey,
  fetchAllDayAutographedPairs,
  fetchTopShotAutographedKeys,
  withAutographSlug,
} from "@/lib/autographs"
import { decorateAutographs, filterAutographsOnly, markAutographs } from "@/lib/sniper/autograph-decorate"
import { autographFieldsFor, fetchEditionMetadata } from "@/lib/concierge/edition-metadata"
import { BADGE_LABELS } from "@/lib/sniper/feed-helpers"
import { computeFilteredSortedRows } from "@/lib/collection/filter-sort"
import { initialCollectionView } from "@/lib/collection/view-reducer"
import { BADGE_PILL_TITLES } from "@/lib/collection/helpers"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const GZ = "06248cc4-b85f-47cd-af67-1855d14acd75"

type Result = { data: unknown; error: { message: string } | null }

/** Thenable query builder whose answer is chosen per table; records the filters. */
function fakeClient(answers: Record<string, Result | ((calls: string[][]) => Result)>) {
  const calls: Record<string, string[][]> = {}
  return {
    calls,
    from(table: string) {
      const log: string[][] = []
      ;(calls[table] ??= []).push(...[] as never[])
      const b: any = {}
      for (const m of ["select", "eq", "not", "in", "order", "limit"]) {
        b[m] = (...args: unknown[]) => {
          log.push([m, ...args.map((a) => JSON.stringify(a))])
          return b
        }
      }
      b.then = (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => {
        ;(calls[table] ??= []).push(...log.map((l) => l))
        const a = answers[table]
        const r = typeof a === "function" ? a(log) : a ?? { data: [], error: null }
        return Promise.resolve(r).then(res, rej)
      }
      return b
    },
  }
}

const deal = (over: Partial<Parameters<typeof markAutographs>[0][number]> = {}) => ({
  editionKey: "219:7408::18",
  intEditionKey: null,
  playerName: "Cooper Flagg",
  setName: "Rookie Debut",
  hasBadge: false,
  badgeSlugs: [] as string[],
  badgeLabels: [] as string[],
  ...over,
})

describe("lib/autographs", () => {
  it("withAutographSlug puts the slug first, once, and only for a signed edition", () => {
    expect(withAutographSlug(["rookie_year"], true)).toEqual([AUTOGRAPH_BADGE_SLUG, "rookie_year"])
    expect(withAutographSlug([AUTOGRAPH_BADGE_SLUG, "mvp"], true)).toEqual([AUTOGRAPH_BADGE_SLUG, "mvp"])
    expect(withAutographSlug(["rookie_year"], false)).toEqual(["rookie_year"])
  })

  it("the sniper labels the slug (BADGE_LABELS carries the key)", () => {
    expect(BADGE_LABELS[AUTOGRAPH_BADGE_SLUG]).toBe("Auto")
    expect(BADGE_LABELS["Autographed"]).toBe("Auto")
  })

  it("Top Shot keys: reads only signed editions of the collection", async () => {
    const c = fakeClient({ editions: { data: [{ external_id: "219:7408::18", autographed_at: "2025-09-18T00:00:00Z" }, { external_id: "219:7408::17", autographed_at: null }], error: null } })
    const r = await fetchTopShotAutographedKeys(c)
    expect(r).toEqual({ ok: true, value: new Set(["219:7408::18"]) })
    const flat = c.calls.editions.map((l) => l.join(" ")).join("\n")
    expect(flat).toContain(`eq "collection_id" "${TS}"`)
    expect(flat).toContain(`not "autographed_at" "is" null`)
  })

  it("a FAILED read is ok:false — never an empty set that reads as 'nothing signed'", async () => {
    const c = fakeClient({ editions: { data: null, error: { message: "canceling statement due to statement timeout" } } })
    const r = await fetchTopShotAutographedKeys(c)
    expect(r.ok).toBe(false)
  })

  it("a FULL 1000-row page is refused as possibly partial (PostgREST clamps reads at 1000)", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ external_id: `1:${i}`, autographed_at: "2025-09-18T00:00:00Z" }))
    const r = await fetchTopShotAutographedKeys(fakeClient({ editions: { data: rows, error: null } }))
    expect(r.ok).toBe(false)
  })

  it("All Day pairs: a player+set counts as signed only when EVERY edition of it is", async () => {
    let n = 0
    const c = fakeClient({
      editions: () => {
        n++
        if (n === 1) {
          return { data: [{ player_name: "Ashton Jeanty", set_name: "Rookie Debut: Signature Edition", autographed_at: "2025-09-01T00:00:00Z" }, { player_name: "X", set_name: "Marquee", autographed_at: "2025-09-01T00:00:00Z" }], error: null }
        }
        return {
          data: [
            { player_name: "Ashton Jeanty", set_name: "Rookie Debut: Signature Edition", autographed_at: "2025-09-01T00:00:00Z" },
            { player_name: "X", set_name: "Marquee", autographed_at: "2025-09-01T00:00:00Z" },
            { player_name: "X", set_name: "Marquee", autographed_at: null }, // mixed pair -> unclaimed
          ],
          error: null,
        }
      },
    })
    const r = await fetchAllDayAutographedPairs(c)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.has(allDayPairKey("Ashton Jeanty", "Rookie Debut: Signature Edition"))).toBe(true)
    expect(r.value.has(allDayPairKey("X", "Marquee"))).toBe(false)
  })
})

describe("lib/sniper/autograph-decorate", () => {
  it("Top Shot: marks the signed PARALLEL and leaves its unsigned sibling alone", () => {
    const out = markAutographs(
      [deal(), deal({ editionKey: "219:7408::17" })],
      "nba-top-shot",
      new Set(["219:7408::18"]),
    )
    expect(out[0]).toMatchObject({ isAutographed: true, hasBadge: true, badgeSlugs: [AUTOGRAPH_BADGE_SLUG], badgeLabels: ["Auto"] })
    expect(out[1]).toMatchObject({ isAutographed: false, hasBadge: false, badgeSlugs: [] })
  })

  it("All Day: matches on player + set", () => {
    const out = markAutographs(
      [deal({ editionKey: "", playerName: "Ashton Jeanty", setName: "Rookie Debut: Signature Edition" })],
      "nfl-all-day",
      new Set([allDayPairKey("Ashton Jeanty", "Rookie Debut: Signature Edition")]),
    )
    expect(out[0].isAutographed).toBe(true)
  })

  it("'Autographs only' keeps signed deals", () => {
    const out = filterAutographsOnly([{ isAutographed: true, badgeSlugs: [] }, { isAutographed: false, badgeSlugs: ["mvp"] }])
    expect(out).toHaveLength(1)
  })

  it("a failed read leaves the board as built and reports autographsRead=false", async () => {
    const c = fakeClient({ editions: { data: null, error: { message: "boom" } } })
    const r = await decorateAutographs(c, "nba-top-shot", [deal({ badgeSlugs: ["rookie_year"], hasBadge: true })])
    expect(r.autographsRead).toBe(false)
    expect(r.deals[0].badgeSlugs).toEqual(["rookie_year"])
  })
})

describe("concierge edition metadata: autographed has THREE states", () => {
  const edRow = (id: string, key: string, signed: boolean) => ({ id, external_id: key, autographed_at: signed ? "2025-09-18T00:00:00Z" : null })

  it("signed = true; unsigned WITH a check row = false; unsigned WITHOUT one = null", async () => {
    const c = fakeClient({
      badge_editions: { data: [{ external_id: "a" }, { external_id: "b" }, { external_id: "c" }], error: null },
      editions: { data: [edRow("u1", "a", true), edRow("u2", "b", false), edRow("u3", "c", false)], error: null },
      edition_autograph_checks: { data: [{ edition_id: "u2", autographed_at: null, checked_at: "2026-10-20T02:40:00Z" }], error: null },
    })
    const r = await fetchEditionMetadata(c as never, TS, ["a", "b", "c"])
    expect(autographFieldsFor(r, "a", TS)).toEqual({ autographed: true, autograph_status: "ok" })
    expect(autographFieldsFor(r, "b", TS)).toEqual({ autographed: false, autograph_status: "ok" })
    expect(autographFieldsFor(r, "c", TS)).toEqual({ autographed: null, autograph_status: "not_tracked" })
  })

  it("a failed autograph read is 'unavailable' with autographed null — and the badges still answer", async () => {
    const c = fakeClient({
      badge_editions: { data: [{ external_id: "a", play_tags: [] }], error: null },
      editions: { data: null, error: { message: "timeout" } },
    })
    const r = await fetchEditionMetadata(c as never, TS, ["a"])
    expect(r.status).toBe("ok")
    expect(autographFieldsFor(r, "a", TS)).toEqual({ autographed: null, autograph_status: "unavailable" })
  })

  it("All Day is tracked; Golazos is not (Atlas carries no autographs there)", async () => {
    const c = fakeClient({
      badge_editions: { data: [{ external_id: "9" }], error: null },
      editions: { data: [edRow("u9", "9", true)], error: null },
    })
    expect(autographFieldsFor(await fetchEditionMetadata(c as never, AD, ["9"]), "9", AD).autographed).toBe(true)
    const g = await fetchEditionMetadata(fakeClient({ badge_editions: { data: [{ external_id: "9" }], error: null } }) as never, GZ, ["9"])
    expect(autographFieldsFor(g, "9", GZ)).toEqual({ autographed: null, autograph_status: "not_tracked" })
  })
})

describe("wallet Collection: the AUTOGRAPHS toggle", () => {
  it("'Autographed' is an allowed pill title and the toggle keeps only signed rows", () => {
    expect(BADGE_PILL_TITLES.has("Autographed")).toBe(true)
    const rows = [
      { id: "1", badgeInfo: { badge_titles: ["Autographed", "Rookie Year"] } },
      { id: "2", badgeInfo: { badge_titles: ["Rookie Year"] } },
      { id: "3" },
    ] as never[]
    const view = { ...initialCollectionView, filterAutographs: true }
    const ctx = { collectionSeriesMap: undefined, duplicateEditions: new Set<string>(), batchEditionStats: new Map() } as never
    const out = computeFilteredSortedRows(rows, view as never, ctx)
    expect(out.map((r: any) => r.id)).toEqual(["1"])
    const off = computeFilteredSortedRows(rows, { ...initialCollectionView } as never, ctx)
    expect(off).toHaveLength(3)
  })
})
