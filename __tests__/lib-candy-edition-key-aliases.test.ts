import { describe, it, expect } from "vitest"
import { canonicalCandyEditionKey, loadEditionKeyAliases } from "@/lib/candy/edition-key-aliases"

// #247 (2026-11-13): the alias reads used by the census (per collection) and the sales indexers (per key).

function db(tables: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ table: string; filters: unknown[] }> = []
  return {
    calls,
    from: (table: string) => {
      const filters: unknown[] = []
      calls.push({ table, filters })
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q },
        in: (c: string, v: unknown) => { filters.push(["in", c, v]); return Promise.resolve(tables[table]) },
        limit: () => Promise.resolve(tables[table]),
      }
      return q
    },
  }
}

describe("canonicalCandyEditionKey", () => {
  it("returns the canonical for an alias, null for a non-alias or a self row", async () => {
    expect(await canonicalCandyEditionKey(db({ candy_edition_key_aliases: { data: [{ canonical_key: "c:x:canon" }], error: null } }), "c:x:cut")).toBe("c:x:canon")
    expect(await canonicalCandyEditionKey(db({ candy_edition_key_aliases: { data: [], error: null } }), "c:x:cut")).toBeNull()
    expect(await canonicalCandyEditionKey(db({ candy_edition_key_aliases: { data: [{ canonical_key: "c:x:cut" }], error: null } }), "c:x:cut")).toBeNull()
  })
  it("a failed read throws — never 'no such edition'", async () => {
    await expect(canonicalCandyEditionKey(db({ candy_edition_key_aliases: { data: null, error: { message: "boom" } } }), "c:x:cut")).rejects.toThrow(/aliases read failed/)
  })
})

describe("loadEditionKeyAliases", () => {
  it("maps only aliases whose canonical edition was read, with its labels", async () => {
    const d = db({
      candy_edition_key_aliases: { data: [{ alias_key: "c:x:a1", canonical_key: "c:x:c1" }, { alias_key: "c:x:a2", canonical_key: "c:x:gone" }], error: null },
      editions: { data: [{ external_id: "c:x:c1", tier: "COMMON", circulation_count: 50 }], error: null },
    })
    const { aliases, error } = await loadEditionKeyAliases(d, "c:x")
    expect(error).toBeNull()
    expect([...aliases.canonOf]).toEqual([["c:x:a1", "c:x:c1"]])
    expect(aliases.labels.get("c:x:c1")).toMatchObject({ circulation_count: 50 })
    expect(d.calls[0].filters).toContainEqual(["eq", "collection_prefix", "c:x"])
  })
  it("a failed read, or a read at the 1,000-row cap, is an error (the census fails the collection)", async () => {
    expect((await loadEditionKeyAliases(db({ candy_edition_key_aliases: { data: null, error: { message: "boom" } } }), "c:x")).error).toMatch(/aliases read/)
    const many = Array.from({ length: 1000 }, (_, i) => ({ alias_key: `c:x:a${i}`, canonical_key: "c:x:c" }))
    expect((await loadEditionKeyAliases(db({ candy_edition_key_aliases: { data: many, error: null } }), "c:x")).error).toMatch(/cap/)
  })
  it("no aliases is an empty map, not an error", async () => {
    const { aliases, error } = await loadEditionKeyAliases(db({ candy_edition_key_aliases: { data: [], error: null } }), "c:x")
    expect(error).toBeNull()
    expect(aliases.canonOf.size).toBe(0)
  })
})
