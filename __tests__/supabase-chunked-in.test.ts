import { describe, it, expect, vi } from "vitest"
import { selectInChunks, IN_CHUNK_SIZE } from "@/lib/supabase/chunked-in"

// A minimal chainable client whose `.from(t).select(c).in(col, slice)` resolves
// to a fixture and records each slice it was asked for.
function mockClient(
  handler: (table: string, column: string, slice: any[]) => { data: any; error: any }
) {
  const calls: { table: string; column: string; slice: any[] }[] = []
  const client = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        in: (column: string, slice: any[]) => {
          calls.push({ table, column, slice })
          return Promise.resolve(handler(table, column, slice))
        },
      }),
    }),
  }
  return { client, calls }
}

describe("selectInChunks", () => {
  it("issues no query for an empty list", async () => {
    const { client, calls } = mockClient(() => ({ data: [{ x: 1 }], error: null }))
    const out = await selectInChunks(client, "t", "*", "id", [])
    expect(out).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("returns all rows in a single chunk for a small list", async () => {
    const { client, calls } = mockClient((_t, _c, slice) => ({
      data: slice.map((v) => ({ id: v })),
      error: null,
    }))
    const out = await selectInChunks(client, "editions", "id, external_id", "external_id", ["a", "b", "c"])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ table: "editions", column: "external_id" })
    expect(out).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }])
  })

  it("splits a >chunkSize list across multiple .in() calls and concatenates (nothing dropped past 1000)", async () => {
    const values = Array.from({ length: IN_CHUNK_SIZE + 250 }, (_, i) => `e${i}`)
    const { client, calls } = mockClient((_t, _c, slice) => ({
      data: slice.map((v) => ({ id: v })),
      error: null,
    }))
    const out = await selectInChunks(client, "fmv_current", "edition_id", "edition_id", values)
    expect(calls).toHaveLength(2)
    expect(calls[0].slice).toHaveLength(IN_CHUNK_SIZE)
    expect(calls[1].slice).toHaveLength(250)
    expect(out).toHaveLength(IN_CHUNK_SIZE + 250)
    expect(out[out.length - 1]).toEqual({ id: `e${IN_CHUNK_SIZE + 249}` })
  })

  it("skips (and logs) a chunk that errors, keeping the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const values = Array.from({ length: IN_CHUNK_SIZE + 3 }, (_, i) => i)
    let call = 0
    const { client } = mockClient((_t, _c, slice) => {
      call++
      return call === 1
        ? { data: null, error: { message: "boom" } }
        : { data: slice.map((v) => ({ id: v })), error: null }
    })
    const out = await selectInChunks(client, "editions", "id", "id", values)
    expect(out).toHaveLength(3) // first chunk dropped, second kept
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("respects a custom chunk size", async () => {
    const { client, calls } = mockClient((_t, _c, slice) => ({
      data: slice.map((v) => ({ id: v })),
      error: null,
    }))
    await selectInChunks(client, "t", "id", "id", ["a", "b", "c", "d", "e"], 2)
    expect(calls.map((c) => c.slice.length)).toEqual([2, 2, 1])
  })
})
