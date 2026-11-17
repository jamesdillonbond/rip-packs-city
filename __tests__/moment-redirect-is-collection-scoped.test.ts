// 2026-10-20 live sweep: /nfl-all-day/moment/1000080 rendered Top Shot's Gordon Hayward
// (All Day's id 1000080 is Dallas Goedert #390). The collection redirect forwarded to
// /moment/<id>, which resolves an nft_id with no collection and prefers Top Shot on a
// collision (~1% of All Day ids).
import { describe, it, expect } from "vitest"
import { resolveScopedMoment } from "@/lib/moment/scoped-moment-href"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const LL = "06248cc4-b85f-47cd-af67-1855d14acd75"

type Row = Record<string, unknown>
function fakeDb(tables: Record<string, Row[]>, fail?: string) {
  return {
    from(t: string) {
      const filters: Array<(r: Row) => boolean> = []
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => String(r[c]) === String(v)), q),
        neq: (c: string, v: unknown) => (filters.push((r) => String(r[c]) !== String(v)), q),
        not: (c: string) => (filters.push((r) => r[c] != null), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.map(String).includes(String(r[c]))), q),
        limit: async (n: number) =>
          t === fail ? { data: null, error: { message: "timeout" } } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, n), error: null },
      }
      return q
    },
  }
}

describe("resolveScopedMoment — an nft_id is unique only within a collection", () => {
  it("a colliding All Day id lands on ITS OWN edition, never the Top Shot moment", async () => {
    const db = fakeDb({
      moments: [],
      wallet_moments_cache: [
        { moment_id: "1000080", collection_id: TS, edition_key: "12:34" },
        { moment_id: "1000080", collection_id: AD, edition_key: "547" },
      ],
      sales: [],
    })
    expect(await resolveScopedMoment(db, "nfl-all-day", "1000080")).toBe("/nfl-all-day/edition/547")
    // and the Top Shot page of the same id keeps the full moment page
    const ts = await resolveScopedMoment(db, "nba-top-shot", "1000080")
    expect(ts).toBe("/nba-top-shot/edition/12%3A34")
  })

  it("this collection's moments row resolves by its globally unique uuid", async () => {
    const db = fakeDb({ moments: [{ id: "u-1", nft_id: "5", collection_id: AD }], wallet_moments_cache: [], sales: [] })
    expect(await resolveScopedMoment(db, "nfl-all-day", "5")).toBe("/moment/u-1")
  })

  it("an id no other collection claims keeps the unscoped forward (its full serial page)", async () => {
    const db = fakeDb({ moments: [], wallet_moments_cache: [{ moment_id: "7", collection_id: AD, edition_key: "9" }], sales: [] })
    expect(await resolveScopedMoment(db, "nfl-all-day", "7")).toBe("/moment/7")
  })

  it("a collision with nothing of THIS collection is a 404 (null), never the other collection's Moment", async () => {
    const db = fakeDb({ moments: [{ id: "u-ts", nft_id: "8", collection_id: TS }], wallet_moments_cache: [], sales: [] })
    expect(await resolveScopedMoment(db, "nfl-all-day", "8")).toBeNull()
  })

  it("falls back to this collection's SALE when it has no wmc row", async () => {
    const db = fakeDb({
      moments: [{ id: "u-ts", nft_id: "9", collection_id: TS }],
      wallet_moments_cache: [],
      sales: [{ nft_id: "9", collection_id: AD, edition_id: "e-1" }],
      editions: [{ id: "e-1", external_id: "321" }],
    })
    expect(await resolveScopedMoment(db, "nfl-all-day", "9")).toBe("/nfl-all-day/edition/321")
  })

  it("a failed read is 'unavailable' (the caller forwards as before), and a uuid id is never re-scoped", async () => {
    expect(await resolveScopedMoment(fakeDb({}, "moments"), "nfl-all-day", "10")).toBe("unavailable")
    expect(await resolveScopedMoment(fakeDb({}), "nfl-all-day", "a1b2c3d4-0000-0000-0000-000000000000")).toBe(
      "/moment/a1b2c3d4-0000-0000-0000-000000000000",
    )
  })

  // 2026-10-27 review: resolve_moment_id also resolves an id from cached_listings_v2
  // (collection via the EDITION) and the two Top Shot listing tables. An id only another
  // collection had LISTED was not seen as a collision, so the unscoped forward rendered
  // that collection's page.
  it("an id only ANOTHER collection has listed is a collision, never forwarded unscoped", async () => {
    const db = fakeDb({
      moments: [],
      wallet_moments_cache: [{ moment_id: "11", collection_id: AD, edition_key: "77" }],
      sales: [],
      cached_listings_v2: [{ flow_id: "11", edition_id: "e-ll" }],
      editions: [{ id: "e-ll", collection_id: LL, external_id: "ll-1" }],
    })
    const r = await resolveScopedMoment(db, "nfl-all-day", "11")
    expect(r).not.toBe("/moment/11")
    expect(r).toBe("/nfl-all-day/edition/77")
  })

  it("an id only a Top Shot listing carries collides for another collection: 404, not Top Shot's moment", async () => {
    for (const t of ["topshot_active_listings", "ts_listings"]) {
      const db = fakeDb({
        moments: [],
        wallet_moments_cache: [],
        sales: [],
        topshot_active_listings: t === "topshot_active_listings" ? [{ nft_id: "12", edition_id: "e-ts" }] : [],
        ts_listings: t === "ts_listings" ? [{ flow_id: "12" }] : [],
      })
      expect(await resolveScopedMoment(db, "nfl-all-day", "12")).toBeNull()
      // ...and on Top Shot's own page the same id keeps its full serial page
      expect(await resolveScopedMoment(db, "nba-top-shot", "12")).toBe("/moment/12")
    }
  })

  it("this collection's OWN listing is not a collision, and resolves a colliding id with no wmc/sale row", async () => {
    const own = fakeDb({
      moments: [],
      wallet_moments_cache: [],
      sales: [],
      cached_listings_v2: [{ flow_id: "13", edition_id: "e-ad" }],
      editions: [{ id: "e-ad", collection_id: AD, external_id: "500" }],
    })
    expect(await resolveScopedMoment(own, "nfl-all-day", "13")).toBe("/moment/13")
    const colliding = fakeDb({
      moments: [{ id: "u-ts", nft_id: "14", collection_id: TS }],
      wallet_moments_cache: [],
      sales: [],
      cached_listings_v2: [{ flow_id: "14", edition_id: "e-ad" }],
      editions: [{ id: "e-ad", collection_id: AD, external_id: "500" }],
    })
    expect(await resolveScopedMoment(colliding, "nfl-all-day", "14")).toBe("/nfl-all-day/edition/500")
  })

  it("a failed listing read is 'unavailable', never a guess", async () => {
    for (const t of ["cached_listings_v2", "topshot_active_listings", "ts_listings"]) {
      const db = fakeDb({ moments: [], wallet_moments_cache: [], sales: [] }, t)
      expect(await resolveScopedMoment(db, "nfl-all-day", "15")).toBe("unavailable")
    }
  })
})
