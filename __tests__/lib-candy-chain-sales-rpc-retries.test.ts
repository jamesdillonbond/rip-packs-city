import { describe, it, expect, vi } from "vitest"
import { newSignatures } from "@/lib/candy/chain-sales"

// lib/candy/chain-sales.ts — the JSON-RPC walker's failure paths (2026-11-22 coverage): a 429 is
// retried on the same node, an HTTP error / RPC error / thrown fetch moves to the next node, a
// read that fails on every node THROWS (a partial list must never advance a cursor), and the
// floor stops a cursor-less walk.

type Ans = { status?: number; body?: unknown; throws?: string }
function fetchSeq(answers: Ans[]) {
  const calls: string[] = []
  const f = vi.fn(async (url: string) => {
    calls.push(url)
    const a = answers.shift() ?? { status: 500 }
    if (a.throws) throw new Error(a.throws)
    const status = a.status ?? 200
    return { status, ok: status < 400, json: async () => a.body } as unknown as Response
  })
  return { f, calls }
}
const sig = (s: string, t = 2_000_000_000) => ({ signature: s, blockTime: t })

describe("newSignatures — RPC failure paths", () => {
  it("retries a 429 on the same node, then reads", async () => {
    vi.useFakeTimers()
    const { f, calls } = fetchSeq([{ status: 429 }, { body: { result: [sig("a"), sig("b")] } }])
    const p = newSignatures(f as any, "ADDR", null, 0, ["u1", "u2"])
    await vi.advanceTimersByTimeAsync(1100)
    const r = await p
    vi.useRealTimers()
    expect(calls).toEqual(["u1", "u1"])
    expect(r).toEqual({ sigs: [sig("a"), sig("b")], newest: "a" })
  })
  it("an HTTP error, an RPC error or a thrown fetch moves to the next node", async () => {
    for (const first of [{ status: 503 }, { body: { error: { message: "busy" } } }, { throws: "reset" }, { throws: "reset" }] as Ans[]) {
      const ans: Ans[] = first.throws ? [first, first, { body: { result: [sig("x")] } }] : [first, { body: { result: [sig("x")] } }]
      const { f, calls } = fetchSeq(ans)
      const r = await newSignatures(f as any, "ADDR", "cur", 0, ["u1", "u2"])
      expect(r.sigs).toEqual([sig("x")])
      expect(calls[calls.length - 1]).toBe("u2")
    }
  })
  it("a read that fails on every node throws with the last cause", async () => {
    const { f } = fetchSeq([{ status: 500 }, { body: { error: {} } }])
    await expect(newSignatures(f as any, "ADDR", null, 0, ["u1", "u2"])).rejects.toThrow("getSignaturesForAddress: error")
  })
  it("with no cursor, stops at the floor", async () => {
    const { f } = fetchSeq([{ body: { result: [sig("new", 200), sig("old", 50)] } }])
    expect(await newSignatures(f as any, "ADDR", null, 100, ["u1"])).toEqual({ sigs: [sig("new", 200)], newest: "new" })
  })
  it("refuses an unbounded walk: more than 50 full pages throws", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => sig("s" + i))
    const f = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ result: page }) }) as unknown as Response)
    await expect(newSignatures(f as any, "ADDR", "cur", 0, ["u1"])).rejects.toThrow("more than 50 pages")
    expect(f).toHaveBeenCalledTimes(50)
  })
})
