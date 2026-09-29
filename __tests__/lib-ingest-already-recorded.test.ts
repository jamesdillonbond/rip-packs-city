import { describe, it, expect } from "vitest"
import { dropAlreadyRecorded } from "@/lib/ingest/already-recorded"

// lib/ingest/already-recorded.ts — the pre-park dedup the two history backfills
// lacked (2026-09-28). The route-level tests pin the wiring; this pins the helper.

function db(tables: Record<string, Array<{ transaction_hash: string; nft_id: string; collection_id: string }>>) {
  const calls: Array<{ table: string; collection: string; hashes: string[] }> = []
  return {
    calls,
    client: {
      from: (table: string) => ({
        select: () => ({
          eq: (_c: string, collection: string) => ({
            in: async (_col: string, hashes: string[]) => {
              calls.push({ table, collection, hashes })
              return {
                data: (tables[table] ?? []).filter((r) => r.collection_id === collection && hashes.includes(r.transaction_hash)),
                error: null,
              }
            },
          }),
        }),
      }),
    },
  }
}

describe("dropAlreadyRecorded", () => {
  it("keeps only sales in neither table, scoped to the collection", async () => {
    const d = db({
      sales: [
        { transaction_hash: "t1", nft_id: "1", collection_id: "C" },
        // same tx+nft in ANOTHER collection must not suppress this one (#142)
        { transaction_hash: "t3", nft_id: "3", collection_id: "OTHER" },
      ],
      unmapped_sales: [{ transaction_hash: "t2", nft_id: "2", collection_id: "C" }],
    })
    const rows = [
      { transaction_hash: "t1", nft_id: "1" },
      { transaction_hash: "t2", nft_id: "2" },
      { transaction_hash: "t3", nft_id: "3" },
      { transaction_hash: "t1", nft_id: "9" }, // same tx, different nft: a different sale
    ]
    const r = await dropAlreadyRecorded(d.client as never, "C", rows)
    expect(r.fresh.map((x) => x.nft_id)).toEqual(["3", "9"])
    expect(r.skipped).toBe(2)
    expect(d.calls.every((c) => c.collection === "C")).toBe(true)
  })

  it("parks a sale repeated WITHIN one scan once", async () => {
    const d = db({})
    const r = await dropAlreadyRecorded(d.client as never, "C", [
      { transaction_hash: "t1", nft_id: "1" },
      { transaction_hash: "t1", nft_id: "1" },
    ])
    expect(r.fresh).toHaveLength(1)
    expect(r.skipped).toBe(1)
  })

  it("chunks the hash list and makes no read for an empty scan", async () => {
    const d = db({})
    await dropAlreadyRecorded(d.client as never, "C", [])
    expect(d.calls).toHaveLength(0)
    const rows = Array.from({ length: 5 }, (_, i) => ({ transaction_hash: `t${i}`, nft_id: String(i) }))
    await dropAlreadyRecorded(d.client as never, "C", rows, 2)
    expect(d.calls.map((c) => c.hashes.length)).toEqual([2, 2, 1, 2, 2, 1])
  })
})
