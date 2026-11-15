import { describe, it, expect } from "vitest"
import {
  claimUsernameFromTopShot,
  isWalletProvenForUser,
  isWalletOwnedByUser,
  claimHandleForProvenWallet,
  releaseHandleFromUnprovenHolder,
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
          // the real UNIQUE(username): a handle another user holds raises 23505
          if (table === "profile_bio" && row?.username) {
            const holder = (rows.profile_bio ?? []).find((r) => r.username === row.username && r.user_id !== row.user_id)
            if (holder) return { error: { code: "23505" } }
            const mine = (rows.profile_bio ?? []).find((r) => r.user_id === row.user_id)
            if (mine) mine.username = row.username
            else (rows.profile_bio ??= []).push({ user_id: row.user_id, username: row.username })
          }
          return { error: null }
        },
        update: (patch: any) => {
          const upd: any = {
            eq: (c: string, v: any) => { filters.push(["eq", c, v]); return upd },
            then: (resolve: any) => {
              writes.push({ table, update: patch })
              if (errs[`${table}:write`]) return resolve({ error: errs[`${table}:write`] })
              for (const r of match()) Object.assign(r, patch)
              return resolve({ error: null })
            },
          }
          return upd
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

// 2026-11-15 (Trevor: "let them have access until we can verify easily and
// effectively"): the handle gate uses the shared ownership rule — proved here >
// verified > saved FIRST — instead of proof only.
describe("isWalletOwnedByUser", () => {
  it("the FIRST saver owns an unproven wallet; a later saver does not", async () => {
    const db = fakeDb({
      saved_wallets: [
        { id: 10, user_id: "u1", wallet_addr: W, verified_at: null },
        { id: 20, user_id: "u2", wallet_addr: W, verified_at: null },
      ],
    })
    expect(await isWalletOwnedByUser(db, "u1", W)).toBe(true)
    expect(await isWalletOwnedByUser(db, "u2", W), "pasting a name someone already saved must not win it").toBe(false)
  })
  it("a VERIFIED saver beats the first saver", async () => {
    const db = fakeDb({
      saved_wallets: [
        { id: 10, user_id: "u1", wallet_addr: W, verified_at: null },
        { id: 20, user_id: "u2", wallet_addr: W, verified_at: "2026-06-15" },
      ],
    })
    expect(await isWalletOwnedByUser(db, "u1", W)).toBe(false)
    expect(await isWalletOwnedByUser(db, "u2", W)).toBe(true)
  })
  it("a wallet PROVEN by another account beats a first save", async () => {
    const db = fakeDb({
      saved_wallets: [{ id: 10, user_id: "u1", wallet_addr: W, verified_at: null }],
      trade_block_wallets: [{ user_id: "u2", source: W, proven_at: "x" }],
      trade_room_sides: [],
    })
    expect(await isWalletOwnedByUser(db, "u1", W)).toBe(false)
    expect(await isWalletOwnedByUser(db, "u2", W)).toBe(true)
  })
  it("FAILS CLOSED on a saved_wallets read error, and for a non-Flow address", async () => {
    const db = fakeDb({ trade_block_wallets: [], trade_room_sides: [] }, { saved_wallets: { message: "boom" } })
    expect(await isWalletOwnedByUser(db, "u1", W)).toBe(false)
    expect(await isWalletOwnedByUser(fakeDb({}), "u1", "nope")).toBe(false)
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
  it("resolve-and-associate gates the claim on ownership, and the trade-block proof claims", async () => {
    const { readFileSync } = await import("node:fs")
    const route = readFileSync("app/api/profile/resolve-and-associate/route.ts", "utf8")
    expect(route).toMatch(/isWalletOwnedByUser\(/)
    expect(route).toMatch(/claimUsernameFromTopShot\([^)]*\{\s*proven\s*\}\)/)
    const tb = readFileSync("app/api/trade-block/route.ts", "utf8")
    expect(tb).toMatch(/saveProvenAccount\([\s\S]{0,800}claimHandleForProvenWallet\(/)
    // 2026-11-15: a proof also VERIFIES the saved wallet, BEFORE the handle claim (so the
    // claim's release step sees the prover as verified).
    expect(tb).toMatch(/saveProvenAccount\([\s\S]{0,400}markSavedWalletVerified\([\s\S]{0,400}claimHandleForProvenWallet\(/)
    const room = readFileSync("app/api/trade-room/[code]/route.ts", "utf8")
    expect(room).toMatch(/setWallet\([\s\S]{0,200}markSavedWalletVerified\(/)
  })
})

// 2026-11-15 claim-then-release: the first saver holds the handle until a proof
// arrives; the prover then takes it back, but never from an unrelated holder.
describe("claimHandleForProvenWallet releases a handle held by an UNPROVEN first saver", () => {
  const base = () => ({
    wallet_usernames: [{ wallet_addr: W, username: "Rigged" }],
    profile_bio: [{ user_id: "squatter", username: "rigged" }],
    saved_wallets: [{ id: 1, user_id: "squatter", wallet_addr: W, verified_at: null }],
    trade_block_wallets: [] as any[],
    trade_room_sides: [] as any[],
  })
  it("the prover gets the handle and the squatter loses it", async () => {
    const rows = base()
    const out = await claimHandleForProvenWallet(fakeDb(rows), "owner", W)
    expect(out).toEqual({ claimed: true, handle: "rigged" })
    expect(rows.profile_bio.find((r) => r.user_id === "squatter")?.username).toBeNull()
    expect(rows.profile_bio.find((r) => r.user_id === "owner")?.username).toBe("rigged")
  })
  it("never touches a holder who did NOT save this wallet (an unrelated, hand-picked handle)", async () => {
    const rows = { ...base(), saved_wallets: [] }
    const out = await claimHandleForProvenWallet(fakeDb(rows), "owner", W)
    expect(out.claimed).toBe(false)
    expect(rows.profile_bio[0].username).toBe("rigged")
  })
  it("never touches a holder who VERIFIED or PROVED this wallet", async () => {
    const v = { ...base(), saved_wallets: [{ id: 1, user_id: "squatter", wallet_addr: W, verified_at: "2026-06-15" }] }
    expect((await claimHandleForProvenWallet(fakeDb(v), "owner", W)).claimed).toBe(false)
    const p = { ...base(), trade_block_wallets: [{ user_id: "squatter", source: W, proven_at: "x" }] }
    expect((await claimHandleForProvenWallet(fakeDb(p), "owner", W)).claimed).toBe(false)
    expect(v.profile_bio[0].username).toBe("rigged")
    expect(p.profile_bio[0].username).toBe("rigged")
  })
  it("releases NOTHING when any read fails", async () => {
    const rows = base()
    const ok = await releaseHandleFromUnprovenHolder(fakeDb(rows, { trade_room_sides: { message: "boom" } }), "owner", W, "rigged")
    expect(ok).toBe(false)
    expect(rows.profile_bio[0].username).toBe("rigged")
  })
  it("does not release when the prover already has a handle of their own", async () => {
    const rows = base()
    rows.profile_bio.push({ user_id: "owner", username: "mine" })
    const out = await claimHandleForProvenWallet(fakeDb(rows), "owner", W)
    expect(out).toEqual({ claimed: false, reason: "already_set", handle: "mine" })
    expect(rows.profile_bio[0].username).toBe("rigged")
  })
})
