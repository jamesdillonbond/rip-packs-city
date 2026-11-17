import { describe, it, expect } from "vitest"
import { markSavedWalletVerified, FLOW_ACCOUNT_PROOF } from "@/lib/wallet/mark-verified"

// 2026-11-15: a Flow account proof (Trade Block / trade room) stamps the collector's
// OWN saved_wallets rows as verified — one verified flag across the site.

function db(rows: any[], err: any = null) {
  const calls: any[] = []
  return {
    calls,
    from(table: string) {
      const f: Array<[string, string, any]> = []
      let patch: any = null
      const q: any = {
        update: (p: any) => { patch = p; return q },
        eq: (c: string, v: any) => { f.push(["eq", c, v]); return q },
        in: (c: string, v: any[]) => { f.push(["in", c, v]); return q },
        is: (c: string, v: any) => { f.push(["is", c, v]); return q },
        select: async () => {
          calls.push({ table, patch, f })
          if (err) return { data: null, error: err }
          const hit = rows.filter((r) =>
            f.every(([k, c, v]) => (k === "eq" ? r[c] === v : k === "in" ? v.includes(r[c]) : r[c] === v)),
          )
          hit.forEach((r) => Object.assign(r, patch))
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        },
      }
      return q
    },
  }
}

const A = "0xbd94cade097e50ac"

describe("markSavedWalletVerified", () => {
  it("stamps only this user's unverified rows for the account, both spellings", async () => {
    const rows = [
      { id: 1, user_id: "u1", wallet_addr: A, verified_at: null },
      { id: 2, user_id: "u1", wallet_addr: A.slice(2), verified_at: null },
      { id: 3, user_id: "u2", wallet_addr: A, verified_at: null },
      { id: 4, user_id: "u1", wallet_addr: A, verified_at: "2026-06-07" },
    ]
    const out = await markSavedWalletVerified(db(rows), "u1", A.toUpperCase().replace("0X", "0x"))
    expect(out).toEqual({ ok: true, updated: 2 })
    expect(rows[0].verified_at).not.toBeNull()
    expect((rows[0] as any).verification_method).toBe(FLOW_ACCOUNT_PROOF)
    expect(rows[2].verified_at, "another user's row is never touched").toBeNull()
    expect(rows[3].verified_at, "an earlier verification keeps its record").toBe("2026-06-07")
  })
  it("a failed write is ok:false, never a silent 0", async () => {
    const out = await markSavedWalletVerified(db([], { message: "boom" }), "u1", A)
    expect(out).toEqual({ ok: false, error: "boom" })
  })
  it("never throws, and refuses a non-Flow address without a write", async () => {
    const d = db([])
    expect((await markSavedWalletVerified(d, "u1", "nope")).ok).toBe(false)
    expect(d.calls).toHaveLength(0)
    const thrower = { from: () => { throw new Error("x") } }
    expect((await markSavedWalletVerified(thrower, "u1", A)).ok).toBe(false)
  })
})
