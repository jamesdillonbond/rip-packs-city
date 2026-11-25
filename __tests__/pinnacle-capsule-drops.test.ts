import { describe, it, expect, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { PINNACLE_CAPSULE_DROPS, PINNACLE_CUSTODY_ADDRESS, isPinnacleChaseOnlyDist, pinnacleCapsuleForDist } from "@/lib/pinnacle/capsule-drops"
import { fetchCapsuleMintedToBuyers } from "@/lib/pinnacle/capsule-mints"
import { isPackRealityDrop } from "@/lib/pinnacle/pin-insight-chips"

const MUGS = PINNACLE_CAPSULE_DROPS[0]

function fakeDb(result: { count: number | null; error: unknown } | Error) {
  const calls: Array<[string, unknown[]]> = []
  const chain: Record<string, unknown> = {}
  for (const m of ["select", "gte", "lt", "like", "neq"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, args])
      if (m === "neq") return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
      return chain
    }
  }
  const db = { from: (t: string) => { calls.push(["from", [t]]); return chain } }
  return { db: db as never, calls }
}

describe("Pinnacle capsule drops", () => {
  it("marks the Mugs Vol.1 chaser dist as chase-only and nothing else", () => {
    expect(isPinnacleChaseOnlyDist("8922")).toBe(true)
    expect(pinnacleCapsuleForDist("8922")?.capsuleName).toBe("Walt Disney Mugs Vol.1")
    expect(isPinnacleChaseOnlyDist("8923")).toBe(false)
    expect(isPinnacleChaseOnlyDist("8874")).toBe(false)
  })

  it("keeps the pack-reality chip off every chase-only dist", () => {
    for (const c of PINNACLE_CAPSULE_DROPS) expect(isPackRealityDrop(c.chaserDistId, c.capsuleName)).toBe(false)
  })

  it("every chase-only dist is excluded by get_pinnacle_pack_reality in SQL (the two lists stay in step)", () => {
    const dir = join(process.cwd(), "supabase/migrations")
    const latest = readdirSync(dir)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f))
      .sort()
      .filter((f) => /FUNCTION\s+public\.get_pinnacle_pack_reality\s*\(/i.test(readFileSync(join(dir, f), "utf8")))
      .pop()
    expect(latest).toBeTruthy()
    const body = readFileSync(join(dir, latest!), "utf8")
    for (const c of PINNACLE_CAPSULE_DROPS) expect(body).toContain(`'${c.chaserDistId}'`)
  })

  it("counts buyer mints inside the sale window, excluding the custody pre-mints", async () => {
    const { db, calls } = fakeDb({ count: 5523, error: null })
    await expect(fetchCapsuleMintedToBuyers(MUGS, db)).resolves.toEqual({ ok: true, mintedToBuyers: 5523 })
    expect(calls).toContainEqual(["from", ["pinnacle_mint_events"]])
    expect(calls).toContainEqual(["gte", ["minted_at", MUGS.saleStart]])
    expect(calls).toContainEqual(["lt", ["minted_at", MUGS.saleEnd]])
    expect(calls).toContainEqual(["like", ["render_id", "OEV1-WDMG-%"]])
    expect(calls).toContainEqual(["neq", ["to_wallet", PINNACLE_CUSTODY_ADDRESS]])
  })

  it("a failed read is not a zero", async () => {
    await expect(fetchCapsuleMintedToBuyers(MUGS, fakeDb({ count: null, error: { message: "boom" } }).db)).resolves.toEqual({ ok: false })
    await expect(fetchCapsuleMintedToBuyers(MUGS, fakeDb({ count: null, error: null }).db)).resolves.toEqual({ ok: false })
    await expect(fetchCapsuleMintedToBuyers(MUGS, fakeDb(new Error("network")).db)).resolves.toEqual({ ok: false })
  })
})
