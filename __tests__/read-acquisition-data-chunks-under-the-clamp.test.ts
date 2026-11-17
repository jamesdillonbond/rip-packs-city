import { describe, it, expect } from "vitest"
import { readAcquisitionData } from "@/lib/acquisitions/read-acquisition-data"

// 2026-11-14: /api/cost-basis sent 14,888 moment ids to get_wallet_acquisition_data_scoped in ONE
// call; PostgREST clamps a set-returning RPC at 1,000 rows, so 13,888 moments came back with no
// acquisition_method — no "Loan Default" label, no trusted P&L basis. This fake clamps exactly like
// PostgREST does: silently, no error.
function clampingClient(calls: number[]) {
  return {
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      const ids = args.p_moment_ids as string[]
      calls.push(ids.length)
      const rows = ids.map((id) => ({ moment_id: id, acquisition_method: "loan_default", buy_price: 1, loan_principal: 1 }))
      return { data: rows.slice(0, 1000), error: null }
    },
  }
}

describe("readAcquisitionData", () => {
  it("returns a row for EVERY moment of a 14,888-moment wallet (the clamp cannot truncate a chunk)", async () => {
    const ids = Array.from({ length: 14888 }, (_, i) => String(i + 1))
    const calls: number[] = []
    const { rows, error } = await readAcquisitionData(clampingClient(calls), "0xabc", ids, "c")
    expect(error).toBeNull()
    expect(rows.length).toBe(14888)
    expect(Math.max(...calls)).toBeLessThanOrEqual(1000)
  })

  it("fails the WHOLE read when any chunk fails — never a partial map published as complete", async () => {
    let n = 0
    const client = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        n++
        if (n === 3) return { data: null, error: { message: "boom" } }
        return { data: (args.p_moment_ids as string[]).map((id) => ({ moment_id: id, acquisition_method: "gift", buy_price: null, loan_principal: null })), error: null }
      },
    }
    const ids = Array.from({ length: 3000 }, (_, i) => String(i))
    const { rows, error } = await readAcquisitionData(client, "0xabc", ids, null)
    expect(error).toBe("boom")
    expect(rows).toEqual([])
  })

  it("dedupes ids and makes no call for an empty list", async () => {
    const calls: number[] = []
    const r = await readAcquisitionData(clampingClient(calls), "0xabc", [], null)
    expect(r.rows).toEqual([])
    expect(calls.length).toBe(0)
    await readAcquisitionData(clampingClient(calls), "0xabc", ["1", "1", "2"], null)
    expect(calls).toEqual([2])
  })
})
