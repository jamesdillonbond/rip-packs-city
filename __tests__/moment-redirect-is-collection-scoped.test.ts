// 2026-10-20 live sweep: /nfl-all-day/moment/1000080 rendered Top Shot's Gordon Hayward
// (All Day's id 1000080 is Dallas Goedert #390). The collection redirect forwarded to
// /moment/<id>, which resolves an nft_id with no collection and prefers Top Shot on a
// collision (~1% of All Day ids).
import { describe, it, expect } from "vitest"
import { resolveScopedMoment } from "@/lib/moment/scoped-moment-href"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"

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
})
