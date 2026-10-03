import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildPublicView,
  claimPack,
  createDraft,
  deleteDraft,
  getDrop,
  GiveawayError,
  listCandidates,
  listCandidatesAcross,
  listCheckedCandidates,
  listDrops,
  sealDrop,
  setStatus,
  verifyDeliveries,
  GIVEAWAY_COLLECTION_ID,
  type ClaimRow,
  type DropRow,
  type PoolRow,
} from "@/lib/giveaways/store"
import { commitmentHash, verifyCommitment } from "@/lib/giveaways/seal"
import type { Holding } from "@/lib/giveaways/topshot-holdings"

// ── a minimal supabase-js stand-in: records each query, answers from a handler ──
interface Q {
  table: string
  op: "select" | "update" | "delete"
  payload?: unknown
  eq: Record<string, unknown>
  single?: boolean
}
type Result = { data: unknown; error: { message: string; code?: string } | null }

function fakeDb(onQuery: (q: Q) => Result, onRpc: (name: string, args: Record<string, unknown>) => Result = () => ({ data: null, error: null })) {
  const queries: Q[] = []
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const db = {
    from(table: string) {
      const q: Q = { table, op: "select", eq: {} }
      const b = {
        select: () => b,
        update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
        delete: () => ((q.op = "delete"), b),
        eq: (k: string, v: unknown) => ((q.eq[k] = v), b),
        order: () => b,
        limit: () => b,
        maybeSingle: () => ((q.single = true), b),
        then: (res: (r: Result) => unknown, rej?: (e: unknown) => unknown) => {
          queries.push(q)
          try {
            return Promise.resolve(onQuery(q)).then(res, rej)
          } catch (e) {
            return Promise.reject(e).then(res, rej)
          }
        },
      }
      return b
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args })
      return Promise.resolve(onRpc(name, args))
    },
  }
  return { db: db as unknown as SupabaseClient, queries, rpcs }
}

const DROP: DropRow = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "test-drop",
  title: "Test drop",
  description: null,
  sponsor_name: "Trevor",
  collection_id: GIVEAWAY_COLLECTION_ID,
  admin_wallet: "0x00000000000000aa",
  status: "draft",
  pack_count: 2,
  moments_per_pack: 2,
  seal_hash: null,
  seal_salt: null,
  sealed_at: null,
  opened_at: null,
  closed_at: null,
  created_at: "2026-09-29T19:00:00Z",
}

function pm(id: string, over: Partial<PoolRow> = {}): PoolRow {
  return {
    moment_id: id,
    pack_no: null,
    slot: null,
    edition_key: null,
    player_name: `P${id}`,
    set_name: "S",
    team_name: null,
    tier: "COMMON",
    serial_number: Number(id),
    fmv_usd: 1,
    image_url: null,
    delivered_at: null,
    last_checked_at: null,
    last_check_recipient_holds: null,
    last_check_admin_holds: null,
    source_wallet: "0x00000000000000aa",
    ...over,
  }
}

const allHeld = async (_a: string, ids: string[]): Promise<Record<string, Holding>> =>
  Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }]))

describe("giveaways/store — reads", () => {
  it("the collection is Top Shot", () => {
    expect(GIVEAWAY_COLLECTION_ID).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
  })

  it("listDrops / getDrop pass rows through and throw a read error (never an empty answer)", async () => {
    const ok = fakeDb(() => ({ data: [DROP], error: null }))
    expect(await listDrops(ok.db)).toEqual([DROP])
    const one = fakeDb(() => ({ data: DROP, error: null }))
    expect(await getDrop(one.db, { slug: "test-drop" })).toEqual(DROP)
    expect(one.queries[0].eq).toEqual({ slug: "test-drop" })
    const none = fakeDb(() => ({ data: null, error: null }))
    expect(await getDrop(none.db, { id: DROP.id })).toBeNull()
    const bad = fakeDb(() => ({ data: null, error: { message: "boom" } }))
    await expect(listDrops(bad.db)).rejects.toEqual({ message: "boom" })
    await expect(getDrop(bad.db, { id: DROP.id })).rejects.toEqual({ message: "boom" })
  })

  it("listCandidates reads only the wallet's Top Shot rows known UNLOCKED, and numbers the FMV", async () => {
    const f = fakeDb(() => ({ data: [{ moment_id: "1", fmv_usd: "2.50" }, { moment_id: "2", fmv_usd: null }], error: null }))
    const c = await listCandidates(f.db, "0x00000000000000aa")
    expect(f.queries[0].eq).toEqual({ wallet_address: "0x00000000000000aa", collection_id: GIVEAWAY_COLLECTION_ID, is_locked: false })
    expect(c.map((x) => x.fmv_usd)).toEqual([2.5, null])
    await expect(listCandidates(fakeDb(() => ({ data: null, error: { message: "x" } })).db, "0x00000000000000aa")).rejects.toBeTruthy()
  })
})

describe("giveaways/store — listCheckedCandidates", () => {
  it("offers only what the CHAIN confirms giftable, and counts what the cache got wrong", async () => {
    const f = fakeDb(() => ({ data: [{ moment_id: "1", fmv_usd: 1 }, { moment_id: "2", fmv_usd: 1 }, { moment_id: "3", fmv_usd: 1 }], error: null }))
    const read = vi.fn(async () => ({ "1": { held: true, locked: false }, "2": { held: true, locked: true } }) as Record<string, Holding>)
    const r = await listCheckedCandidates(f.db, "0x00000000000000aa", read)
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["1", "2", "3"])
    expect(r.candidates.map((c) => c.moment_id)).toEqual(["1"])
    expect(r.excluded).toEqual({ locked: 1, not_held: 1 })
    expect(r.cache_count).toBe(3)
  })
  it("a failed chain read throws — never a list it could not verify", async () => {
    const f = fakeDb(() => ({ data: [{ moment_id: "1", fmv_usd: 1 }], error: null }))
    await expect(listCheckedCandidates(f.db, "0x00000000000000aa", async () => Promise.reject(new Error("HTTP 403")))).rejects.toThrow(/403/)
  })
  it("listCandidatesAcross lists each account on its own and tags every candidate with its source (2026-10-03)", async () => {
    const f = fakeDb((q) =>
      q.eq.wallet_address === "0x00000000000000bb" ? { data: [{ moment_id: "9", fmv_usd: 2 }], error: null } : { data: [], error: null },
    )
    const read = vi.fn(allHeld)
    const r = await listCandidatesAcross(
      f.db,
      [
        { address: "0x00000000000000aa", role: "flow_wallet", topshot_count: 0 },
        { address: "0x00000000000000bb", role: "linked", topshot_count: 15 },
        { address: "0x00000000000000cc", role: "linked", topshot_count: null },
      ],
      read,
    )
    expect(r.candidates.map((c) => `${c.moment_id}@${c.source_wallet}`)).toEqual(["9@0x00000000000000bb"])
    expect(r.accounts.map((a) => [a.address, a.onchain_count, a.cache_count, a.giftable])).toEqual([
      ["0x00000000000000aa", 0, 0, 0],
      ["0x00000000000000bb", 15, 1, 1],
      ["0x00000000000000cc", null, 0, 0],
    ])
    expect(read).toHaveBeenCalledTimes(1) // empty caches make no chain call
  })
  it("an empty cache makes no chain call", async () => {
    const read = vi.fn()
    const r = await listCheckedCandidates(fakeDb(() => ({ data: [], error: null })).db, "0x00000000000000aa", read)
    expect(read).not.toHaveBeenCalled()
    expect(r.candidates).toEqual([])
  })
})

describe("giveaways/store — createDraft", () => {
  const input = {
    slug: "s-1",
    title: "T",
    description: null,
    sponsor_name: "Trevor",
    admin_wallet: "0x00000000000000aa",
    pack_count: 1,
    moments_per_pack: 1,
    moment_ids: ["1"],
  }
  it("returns the new id", async () => {
    const f = fakeDb(() => ({ data: null, error: null }), () => ({ data: "new-id", error: null }))
    expect(await createDraft(f.db, input)).toBe("new-id")
    expect(f.rpcs[0].name).toBe("create_giveaway_draft_multi")
    expect(f.rpcs[0].args.p_collection_id).toBe(GIVEAWAY_COLLECTION_ID)
    // a single-account draft sends no sources: every moment comes from admin_wallet
    expect(f.rpcs[0].args.p_source_wallets).toBeNull()
  })
  it("a multi-account draft sends one source per moment (2026-10-03)", async () => {
    const f = fakeDb(() => ({ data: null, error: null }), () => ({ data: "new-id", error: null }))
    const sources = input.moment_ids.map((_, i) => (i % 2 ? "0x00000000000000bb" : "0x00000000000000aa"))
    await createDraft(f.db, { ...input, source_wallets: sources })
    expect(f.rpcs[0].args.p_source_wallets).toEqual(sources)
  })
  it("a refusal (22023) or a duplicate slug (23505) becomes a 400 with the function's own message", async () => {
    for (const code of ["22023", "23505"]) {
      const f = fakeDb(() => ({ data: null, error: null }), () => ({ data: null, error: { message: "giveaway: locked", code } }))
      await expect(createDraft(f.db, input)).rejects.toMatchObject({ name: "GiveawayError", status: 400, message: "giveaway: locked" })
    }
  })
  it("any other error is rethrown as-is (classified by the route)", async () => {
    const f = fakeDb(() => ({ data: null, error: null }), () => ({ data: null, error: { message: "timeout", code: "57014" } }))
    await expect(createDraft(f.db, input)).rejects.toEqual({ message: "timeout", code: "57014" })
  })
})

describe("giveaways/store — sealDrop", () => {
  const pool = [pm("1"), pm("2"), pm("3"), pm("4")]
  const dbWithPool = (p: PoolRow[], rpcResult: Result = { data: null, error: null }) =>
    fakeDb(() => ({ data: p, error: null }), () => rpcResult)

  it("seals: on-chain check, then one atomic RPC carrying an assignment that matches its hash", async () => {
    const f = dbWithPool(pool)
    const read = vi.fn(allHeld)
    const r = await sealDrop(f.db, DROP, read)
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["1", "2", "3", "4"])
    expect(f.rpcs).toHaveLength(1)
    const args = f.rpcs[0].args as { p_assignments: Array<{ moment_id: string; pack_no: number; slot: number }>; p_hash: string; p_salt: string }
    expect(args.p_hash).toBe(r.hash)
    const manifest = [1, 2]
      .map((p) => `${p}:${args.p_assignments.filter((a) => a.pack_no === p).sort((a, b) => a.slot - b.slot).map((a) => a.moment_id).join(",")}`)
      .join(";")
    expect(verifyCommitment(args.p_salt, manifest, args.p_hash)).toBe(true)
    expect(r.check.pool_fmv_usd).toBe(4)
  })

  it("refuses a drop that is not a draft", async () => {
    await expect(sealDrop(dbWithPool(pool).db, { ...DROP, status: "open" }, allHeld)).rejects.toMatchObject({ code: "wrong_status" })
  })

  it("refuses an unpriced moment (the prize value must be stated)", async () => {
    const f = dbWithPool([pm("1"), pm("2", { fmv_usd: null }), pm("3"), pm("4")])
    await expect(sealDrop(f.db, DROP, allHeld)).rejects.toMatchObject({ code: "unpriced" })
    expect(f.rpcs).toHaveLength(0)
  })

  it("refuses a pool over the $5,000 NY/FL line", async () => {
    const f = dbWithPool([pm("1", { fmv_usd: 4000 }), pm("2", { fmv_usd: 1001 }), pm("3"), pm("4")])
    await expect(sealDrop(f.db, DROP, allHeld)).rejects.toMatchObject({ code: "over_cap" })
  })

  it("refuses when the chain says the admin no longer holds a moment", async () => {
    const read = async (_a: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, id === "3" ? { held: false, locked: null } : { held: true, locked: false }])) as Record<string, Holding>
    await expect(sealDrop(dbWithPool(pool).db, DROP, read)).rejects.toMatchObject({ code: "not_held", message: expect.stringContaining("3") })
  })

  it("refuses when the chain says a moment is locked (a locked Moment can't be gifted)", async () => {
    const read = async (_a: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { held: true, locked: id === "2" }])) as Record<string, Holding>
    await expect(sealDrop(dbWithPool(pool).db, DROP, read)).rejects.toMatchObject({ code: "locked", message: expect.stringContaining("2") })
  })

  it("a failed chain read fails the seal (never seals on a read that didn't happen)", async () => {
    const f = dbWithPool(pool)
    await expect(sealDrop(f.db, DROP, async () => Promise.reject(new Error("Flow script HTTP 500")))).rejects.toMatchObject({
      name: "GiveawayError",
      status: 502,
      code: "chain_read_failed",
    })
    expect(f.rpcs).toHaveLength(0)
  })

  it("a pool across linked accounts is checked against EACH moment's own source (2026-10-03)", async () => {
    const mixed = [pm("1"), pm("2"), pm("3", { source_wallet: "0x00000000000000bb" }), pm("4", { source_wallet: "0x00000000000000bb" })]
    const read = vi.fn(allHeld)
    await sealDrop(dbWithPool(mixed).db, DROP, read)
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["1", "2"])
    expect(read).toHaveBeenCalledWith("0x00000000000000bb", ["3", "4"])
    // and a moment held only by the OTHER account is not held
    const crossed = async (a: string, ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { held: a === "0x00000000000000aa", locked: false }])) as Record<string, Holding>
    await expect(sealDrop(dbWithPool(mixed).db, DROP, crossed)).rejects.toMatchObject({ code: "not_held", message: expect.stringContaining("3, 4") })
  })

  it("maps the seal function's refusal to a 409 and rethrows anything else", async () => {
    await expect(sealDrop(dbWithPool(pool, { data: null, error: { message: "not exactly once", code: "22023" } }).db, DROP, allHeld)).rejects.toMatchObject({
      status: 409,
    })
    await expect(sealDrop(dbWithPool(pool, { data: null, error: { message: "down", code: "PGRST002" } }).db, DROP, allHeld)).rejects.toEqual({
      message: "down",
      code: "PGRST002",
    })
  })
})

describe("giveaways/store — status changes", () => {
  it("sealed → open and open → closed are conditional updates", async () => {
    const f = fakeDb(() => ({ data: [{ id: DROP.id }], error: null }))
    await setStatus(f.db, { ...DROP, status: "sealed" }, "open")
    expect(f.queries[0]).toMatchObject({ op: "update", eq: { id: DROP.id, status: "sealed" } })
    expect((f.queries[0].payload as { status: string; opened_at?: string }).opened_at).toBeTruthy()
    await setStatus(f.db, { ...DROP, status: "open" }, "closed")
    expect(f.queries[1]).toMatchObject({ eq: { status: "open" } })
    expect((f.queries[1].payload as { closed_at?: string }).closed_at).toBeTruthy()
  })
  it("refuses a wrong starting status without touching the db, and a lost race after", async () => {
    const f = fakeDb(() => ({ data: [], error: null }))
    await expect(setStatus(f.db, DROP, "open")).rejects.toBeInstanceOf(GiveawayError)
    expect(f.queries).toHaveLength(0)
    await expect(setStatus(f.db, { ...DROP, status: "sealed" }, "open")).rejects.toMatchObject({ message: expect.stringContaining("reload") })
    await expect(setStatus(fakeDb(() => ({ data: null, error: { message: "x" } })).db, { ...DROP, status: "open" }, "closed")).rejects.toEqual({ message: "x" })
  })
  it("deleteDraft deletes only a draft", async () => {
    const f = fakeDb(() => ({ data: [{ id: DROP.id }], error: null }))
    await deleteDraft(f.db, DROP)
    expect(f.queries[0]).toMatchObject({ op: "delete", eq: { id: DROP.id, status: "draft" } })
    await expect(deleteDraft(f.db, { ...DROP, status: "sealed" })).rejects.toMatchObject({ code: "wrong_status" })
    await expect(deleteDraft(fakeDb(() => ({ data: [], error: null })).db, DROP)).rejects.toMatchObject({ code: "wrong_status" })
    await expect(deleteDraft(fakeDb(() => ({ data: null, error: { message: "y" } })).db, DROP)).rejects.toEqual({ message: "y" })
  })
})

describe("giveaways/store — verifyDeliveries", () => {
  const OPEN: DropRow = { ...DROP, status: "open" }
  const pool = [
    pm("1", { pack_no: 1, slot: 1 }),
    pm("2", { pack_no: 1, slot: 2 }),
    pm("3", { pack_no: 2, slot: 1 }),
    pm("4", { pack_no: 2, slot: 2 }),
  ]
  const claims: ClaimRow[] = [
    { pack_no: 1, user_id: "u1", topshot_username: "alice", recipient_address: "0x0000000000000001", claimed_at: "t" },
    { pack_no: 2, user_id: "u2", topshot_username: "bob", recipient_address: "0x0000000000000002", claimed_at: "t" },
  ]
  function db(poolRows = pool, claimRows = claims, updateResult: Result = { data: [{}], error: null }) {
    return fakeDb((q) => {
      if (q.op === "update") return updateResult
      return q.table === "giveaway_claims" ? { data: claimRows, error: null } : { data: poolRows, error: null }
    })
  }

  it("classifies delivered / awaiting / missing and stamps delivered_at once", async () => {
    const f = db()
    const read = async (addr: string, ids: string[]) => {
      if (addr === "0x0000000000000001") return { "1": { held: true, locked: false }, "2": { held: false, locked: null } } as Record<string, Holding>
      if (addr === "0x0000000000000002") return { "3": { held: false, locked: null }, "4": { held: false, locked: null } } as Record<string, Holding>
      // the admin still holds 2 and 3; 4 went elsewhere
      return Object.fromEntries(ids.map((id) => [id, { held: id !== "4", locked: false }])) as Record<string, Holding>
    }
    const r = await verifyDeliveries(f.db, OPEN, read)
    expect(r).toMatchObject({ checked: 4, delivered: 1, pending: 2, missing: 1, failed_recipients: [], written: 4, write_error: null })
    const updates = f.queries.filter((q) => q.op === "update")
    const by = Object.fromEntries(updates.map((u) => [u.eq.moment_id, u.payload as Record<string, unknown>]))
    expect(by["1"]).toMatchObject({ last_check_recipient_holds: true, last_check_admin_holds: false })
    expect(by["1"].delivered_at).toBeTruthy()
    expect(by["2"]).toMatchObject({ last_check_recipient_holds: false, last_check_admin_holds: true })
    expect(by["2"].delivered_at).toBeUndefined()
    expect(by["4"]).toMatchObject({ last_check_recipient_holds: false, last_check_admin_holds: false })
  })

  it("never re-stamps an existing delivered_at", async () => {
    const f = db([pm("1", { pack_no: 1, slot: 1, delivered_at: "2026-09-01T00:00:00Z" })], [claims[0]])
    await verifyDeliveries(f.db, OPEN, async () => ({ "1": { held: true, locked: false } }))
    expect((f.queries.find((q) => q.op === "update")!.payload as Record<string, unknown>).delivered_at).toBeUndefined()
  })

  it("a recipient whose chain read FAILED is reported and their rows are NOT touched", async () => {
    const f = db()
    const read = async (addr: string, ids: string[]) => {
      if (addr === "0x0000000000000002") throw new Error("HTTP 500")
      return Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])) as Record<string, Holding>
    }
    const r = await verifyDeliveries(f.db, OPEN, read)
    expect(r.failed_recipients).toEqual(["0x0000000000000002"])
    expect(r.checked).toBe(2)
    const touched = f.queries.filter((q) => q.op === "update").map((q) => q.eq.moment_id)
    expect(touched.sort()).toEqual(["1", "2"])
  })

  it("an undelivered moment whose ADMIN-side read failed is not classified (not called missing)", async () => {
    const f = db()
    const read = async (addr: string) => {
      if (addr === OPEN.admin_wallet) throw new Error("HTTP 500")
      return {} as Record<string, Holding>
    }
    const r = await verifyDeliveries(f.db, OPEN, read)
    expect(r.missing).toBe(0)
    expect(r.checked).toBe(0)
    expect(f.queries.filter((q) => q.op === "update")).toHaveLength(0)
    expect(r.failed_recipients.length).toBe(4)
  })

  it("the sponsor side is read from each moment's OWN source; one failed source leaves the others classified", async () => {
    const mixed = [
      pm("1", { pack_no: 1, slot: 1 }),
      pm("2", { pack_no: 1, slot: 2, source_wallet: "0x00000000000000bb" }),
      pm("3", { pack_no: 2, slot: 1 }),
      pm("4", { pack_no: 2, slot: 2, source_wallet: "0x00000000000000bb" }),
    ]
    const f = db(mixed)
    const read = async (addr: string, ids: string[]) => {
      if (addr === "0x00000000000000bb") throw new Error("HTTP 500")
      if (addr === "0x00000000000000aa") return Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])) as Record<string, Holding>
      return {} as Record<string, Holding> // recipients hold nothing yet
    }
    const r = await verifyDeliveries(f.db, OPEN, read)
    expect(r).toMatchObject({ checked: 2, pending: 2, missing: 0 })
    expect(r.failed_recipients.sort()).toEqual(["0x00000000000000bb (for 2)", "0x00000000000000bb (for 4)"])
    expect(f.queries.filter((q) => q.op === "update").map((q) => q.eq.moment_id).sort()).toEqual(["1", "3"])
  })

  it("an unclaimed pack is not checked at all", async () => {
    const f = db(pool, [claims[0]])
    const read = vi.fn(allHeld)
    const r = await verifyDeliveries(f.db, OPEN, read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(r.checked).toBe(2)
  })

  it("a write error is reported and `written` counts only rows actually written", async () => {
    const f = db(pool, claims, { data: null, error: { message: "write failed" } })
    const r = await verifyDeliveries(f.db, OPEN, allHeld)
    expect(r.checked).toBe(4)
    expect(r.written).toBe(0)
    expect(r.write_error).toBe("write failed")
  })
})

describe("giveaways/store — buildPublicView", () => {
  const salt = "ab".repeat(32)
  const sealedPool = [
    pm("1", { pack_no: 2, slot: 1, fmv_usd: 1 }),
    pm("2", { pack_no: 1, slot: 1, fmv_usd: 9, delivered_at: "2026-09-29T20:00:00Z" }),
    pm("3", { pack_no: 1, slot: 2, fmv_usd: 1 }),
    pm("4", { pack_no: 2, slot: 2, fmv_usd: 5 }),
  ]
  const hash = commitmentHash(salt, "1:2,3;2:1,4")
  const SEALED: DropRow = { ...DROP, status: "open", seal_hash: hash, seal_salt: salt, sealed_at: "2026-09-29T19:30:00Z" }
  const claims: ClaimRow[] = [{ pack_no: 1, user_id: "me", topshot_username: "alice", recipient_address: "0x0000000000000001", claimed_at: "t" }]

  it("a draft is not public", () => {
    expect(buildPublicView(DROP, [], [], null)).toBeNull()
    expect(buildPublicView({ ...DROP, status: "open" }, [], [], null)).toBeNull()
  })

  it("lists the pool by value, never by pack, and hides the salt while open", () => {
    const v = buildPublicView(SEALED, sealedPool, claims, null)!
    expect(v.pool.map((m) => m.moment_id)).toEqual(["2", "4", "1", "3"])
    expect(JSON.stringify(v.pool)).not.toContain("pack_no")
    expect(v.verification).toBeNull()
    expect(JSON.stringify(v)).not.toContain(salt)
    expect(v.me).toBeNull()
    expect(v.drop.claimed_count).toBe(1)
    expect(v.values).toMatchObject({ pool_fmv_usd: 16, best_pack_usd: 10 })
  })

  it("shows the viewer their own pack only, in slot order, with delivery", () => {
    const v = buildPublicView(SEALED, sealedPool, claims, "me")!
    expect(v.me!.pack_no).toBe(1)
    expect(v.me!.moments.map((m) => [m.moment_id, m.delivered])).toEqual([
      ["2", true],
      ["3", false],
    ])
    expect(buildPublicView(SEALED, sealedPool, claims, "someone-else")!.me).toBeNull()
  })

  it("after close, publishes a salt + manifest that reproduce the sealed hash", () => {
    const v = buildPublicView({ ...SEALED, status: "closed" }, sealedPool, claims, null)!
    expect(v.verification).toEqual({ salt, manifest: "1:2,3;2:1,4" })
    expect(verifyCommitment(v.verification!.salt, v.verification!.manifest, v.drop.seal_hash)).toBe(true)
  })
})

describe("giveaways/store — claimPack", () => {
  it("returns the database's outcome", async () => {
    const f = fakeDb(() => ({ data: null, error: null }), () => ({ data: [{ pack_no: 3, outcome: "claimed" }], error: null }))
    expect(await claimPack(f.db, DROP.id, "u", "alice", "0x0000000000000001")).toEqual({ outcome: "claimed", pack_no: 3 })
    const g = fakeDb(() => ({ data: null, error: null }), () => ({ data: { pack_no: null, outcome: "all_claimed" }, error: null }))
    expect(await claimPack(g.db, DROP.id, "u", "alice", "0x0000000000000001")).toEqual({ outcome: "all_claimed", pack_no: null })
  })
  it("throws on an error or a missing outcome", async () => {
    await expect(claimPack(fakeDb(() => ({ data: null, error: null }), () => ({ data: null, error: { message: "e" } })).db, DROP.id, "u", "a", "0x1")).rejects.toEqual({
      message: "e",
    })
    await expect(claimPack(fakeDb(() => ({ data: null, error: null }), () => ({ data: [], error: null })).db, DROP.id, "u", "a", "0x1")).rejects.toThrow(/no outcome/)
  })
})
