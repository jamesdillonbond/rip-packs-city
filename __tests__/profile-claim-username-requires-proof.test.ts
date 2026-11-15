import { describe, it, expect } from "vitest"
import {
  claimUsernameFromTopShot,
  isWalletProvenForUser,
  claimHandleForProvenWallet,
} from "@/lib/profile/claim-username"

// Deep audit 2026-11-15 A-1 (Trevor: "Proof required"). A pasted Top Shot username
// or address is a public identifier, not ownership: it must never hand out that
// collector's public handle unless THIS account has proven the wallet.

type Rows = Record<string, any[]>
type Errs = Record<string, any>

function fakeDb(rows: Rows, errs: Errs = {}, writes: any[] = []) {
  return {
    from(table: string) {
      const filters: Array<[string, string, any]> = []
      const q: any = {
        select: () => q,
        eq: (c: string, v: any) => { filters.push(["eq", c, v]); return q },
        in: (c: string, v: any[]) => { filters.push(["in", c, v]); return q },
        not: (c: string, _op: string, _v: any) => { filters.push(["notnull", c, null]); return q },
        limit: () => q,
        maybeSingle: async () => {
          if (errs[table]) return { data: null, error: errs[table] }
          const r = match()
          return { data: r[0] ?? null, error: null }
        },
        upsert: async (row: any) => {
          writes.push({ table, row })
          if (errs[`${table}:write`]) return { error: errs[`${table}:write`] }
          return { error: null }
        },
        then: (resolve: any) => {
          if (errs[table]) return resolve({ data: null, error: errs[table] })
          return resolve({ data: match(), error: null })
        },
      }
      function match() {
        return (rows[table] ?? []).filter((r) =>
          filters.every(([k, c, v]) =>
            k === "eq" ? r[c] === v : k === "in" ? v.includes(r[c]) : r[c] != null,
          ),
        )
      }
      return q
    },
  }
}

const W = "0xbd94cade097e50ac"

describe("isWalletProvenForUser", () => {
  it("is true only for a proven trade-block or trade-room source of THIS user", async () => {
    const db = fakeDb({
      trade_block_wallets: [{ user_id: "u1", source: W, proven_at: "2026-11-15" }],
      trade_room_sides: [],
    })
    expect(await isWalletProvenForUser(db, "u1", W)).toBe(true)
    expect(await isWalletProvenForUser(db, "u2", W), "another user's proof proves nothing").toBe(false)
    expect(await isWalletProvenForUser(db, "u1", "0x1111111111111111")).toBe(false)
  })
  it("accepts a signed trade-room side as proof", async () => {
    const db = fakeDb({ trade_block_wallets: [], trade_room_sides: [{ user_id: "u1", source: W, proven_at: "x" }] })
    expect(await isWalletProvenForUser(db, "u1", W)).toBe(true)
  })
  it("FAILS CLOSED on a read error", async () => {
    const db = fakeDb(
      { trade_block_wallets: [{ user_id: "u1", source: W, proven_at: "x" }] },
      { trade_room_sides: { message: "boom" } },
    )
    expect(await isWalletProvenForUser(db, "u1", W)).toBe(false)
  })
  it("is false for a non-Flow address", async () => {
    expect(await isWalletProvenForUser(fakeDb({}), "u1", "not-an-address")).toBe(false)
  })
})

describe("claimUsernameFromTopShot with { proven }", () => {
  it("does NOT write a handle for an unproven wallet", async () => {
    const writes: any[] = []
    const db = fakeDb({ profile_bio: [] }, {}, writes)
    const out = await claimUsernameFromTopShot(db, "u1", "Rigged", { proven: false })
    expect(out).toEqual({ claimed: false, reason: "unproven" })
    expect(writes, "an unproven claim must write nothing").toHaveLength(0)
  })
  it("still reports an existing handle when unproven (no nag for returning users)", async () => {
    const db = fakeDb({ profile_bio: [{ user_id: "u1", username: "mine" }] })
    const out = await claimUsernameFromTopShot(db, "u1", "Rigged", { proven: false })
    expect(out).toEqual({ claimed: false, reason: "already_set", handle: "mine" })
  })
  it("claims when proven (and by default, for callers holding a proof)", async () => {
    const writes: any[] = []
    const db = fakeDb({ profile_bio: [] }, {}, writes)
    const out = await claimUsernameFromTopShot(db, "u1", "Rigged", { proven: true })
    expect(out.claimed).toBe(true)
    expect(writes).toHaveLength(1)
  })
})

describe("claimHandleForProvenWallet", () => {
  it("claims the wallet's known Top Shot username", async () => {
    const writes: any[] = []
    const db = fakeDb({ wallet_usernames: [{ wallet_addr: W.slice(2), username: "Rigged" }], profile_bio: [] }, {}, writes)
    const out = await claimHandleForProvenWallet(db, "u1", W)
    expect(out.claimed).toBe(true)
    expect(writes).toHaveLength(1)
  })
  it("never throws and writes nothing when the username is unknown or the read fails", async () => {
    const writes: any[] = []
    expect((await claimHandleForProvenWallet(fakeDb({ wallet_usernames: [] }, {}, writes), "u1", W)).claimed).toBe(false)
    expect((await claimHandleForProvenWallet(fakeDb({}, { wallet_usernames: { message: "x" } }, writes), "u1", W)).claimed).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

describe("route wiring", () => {
  it("resolve-and-associate gates the claim on proof, and the trade-block proof claims", async () => {
    const { readFileSync } = await import("node:fs")
    const route = readFileSync("app/api/profile/resolve-and-associate/route.ts", "utf8")
    expect(route).toMatch(/isWalletProvenForUser\(/)
    expect(route).toMatch(/claimUsernameFromTopShot\([^)]*\{\s*proven\s*\}\)/)
    const tb = readFileSync("app/api/trade-block/route.ts", "utf8")
    expect(tb).toMatch(/saveProvenAccount\([\s\S]{0,400}claimHandleForProvenWallet\(/)
  })
})
