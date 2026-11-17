import { describe, it, expect } from "vitest"
import { fetchPaniniPremiums, PANINI_PREMIUMS_LIMIT } from "@/lib/insights/panini-premiums"

/**
 * The Panini premiums fetcher (2026-10-10). Stated as absences: a parallel priced at LOW or
 * ASK_ONLY never reaches the board (the read filters BOTH sides to HIGH/MEDIUM), a failed read of
 * either board throws (never an empty board), and a full page says it is capped.
 */

type Res = { data?: unknown; error?: unknown }
function db(over: Record<string, Res> = {}) {
  const ins: Record<string, string[]> = {}
  const gtes: Record<string, string[]> = {}
  const base: Record<string, Res> = {
    panini_parallel_premiums: { data: [{ external_id: "e1", premium_mult: 9 }] },
    panini_serial_premiums: { data: [{ sku: "s1", external_id: "e2", premium_mult: 40 }] },
    ...over,
  }
  return {
    ins,
    gtes,
    from(table: string) {
      const b: any = {
        select: () => b,
        in: (col: string, v: unknown[]) => {
          ;(ins[table] ??= []).push(`${col}=${v.join("|")}`)
          return b
        },
        gte: (col: string, v: unknown) => {
          ;(gtes[table] ??= []).push(`${col}>=${String(v)}`)
          return b
        },
        order: () => b,
        limit: () => b,
        then: (resolve: any) => resolve({ data: null, error: null, ...base[table] }),
      }
      return b
    },
  }
}

describe("fetchPaniniPremiums", () => {
  it("reads parallels at HIGH/MEDIUM on BOTH sides and >= 1.5x — no LOW or ask-only price heads the board", async () => {
    const d = db() as any
    const r = await fetchPaniniPremiums(d)
    expect(d.ins.panini_parallel_premiums).toEqual(["parallel_confidence=HIGH|MEDIUM", "base_confidence=HIGH|MEDIUM"])
    expect(d.gtes.panini_parallel_premiums).toEqual(["premium_mult>=1.5"])
    expect(r.parallels).toHaveLength(1)
    expect(r.serials).toHaveLength(1)
    expect(r.parallelsCapped).toBe(false)
  })

  it("a failed read of either board throws — never an empty board", async () => {
    await expect(fetchPaniniPremiums(db({ panini_parallel_premiums: { data: null, error: { message: "x" } } }))).rejects.toThrow(/panini_parallel_premiums/)
    await expect(fetchPaniniPremiums(db({ panini_serial_premiums: { data: null, error: { message: "x" } } }))).rejects.toThrow(/panini_serial_premiums/)
  })

  it("a full page says it is capped", async () => {
    const full = Array.from({ length: PANINI_PREMIUMS_LIMIT }, (_, i) => ({ sku: `s${i}`, external_id: `e${i}` }))
    const r = await fetchPaniniPremiums(db({ panini_serial_premiums: { data: full } }))
    expect(r.serialsCapped).toBe(true)
  })
})
