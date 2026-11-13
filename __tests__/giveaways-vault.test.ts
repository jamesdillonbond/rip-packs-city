import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { confirmFunding, instantDeliveryEnabled, markReturned, sendFromVault, setUpVault, VaultSealUnknownError, vaultConfig, vaultStatus } from "@/lib/giveaways/vault"
import { DELIVER_OWN_BATCH_CADENCE, DELIVER_OWN_SIMULATION_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import { VAULT_SETUP_CADENCE, VAULT_SETUP_SIMULATION_SCRIPT, VAULT_STATUS_SCRIPT } from "@/lib/giveaways/vault-cadence"
import type { DropRow, PoolRow } from "@/lib/giveaways/store"
import type { CdcValue } from "@/lib/giveaways/flow-script"
import type { Holding } from "@/lib/giveaways/topshot-holdings"

// The giveaway vault (2026-11-08). What matters: nothing signs without a complete key AND
// the switch; the vault only ever sends to recipients the DATABASE handed out, after a
// simulation that landed every Moment; a seal that wasn't read is never "not sent"; funding
// is recorded only when the chain shows the whole pool in the vault.

const VAULT = "0x00000000000000cc"
const KEY = "a".repeat(64)
const ENV = { GIVEAWAY_VAULT_ADDR: VAULT, GIVEAWAY_VAULT_PRIVATE_KEY: KEY, GIVEAWAY_VAULT_KEY_INDEX: "0", RPC_GIVEAWAY_INSTANT_DELIVERY: "1" } as unknown as NodeJS.ProcessEnv

const DROP: DropRow = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "fall-drop",
  title: "Fall drop",
  description: null,
  sponsor_name: "Trevor",
  collection_id: "c",
  admin_wallet: "0x00000000000000aa",
  status: "open",
  pack_count: 2,
  moments_per_pack: 1,
  seal_hash: "a".repeat(64),
  seal_salt: "b".repeat(64),
  sealed_at: "2026-11-08T20:00:00Z",
  opened_at: "2026-11-08T20:00:00Z",
  closed_at: null,
  created_at: "2026-11-08T19:00:00Z",
  deal_mode: "balanced",
  vault_address: VAULT,
}

function pm(id: string, over: Partial<PoolRow> = {}): PoolRow {
  return {
    moment_id: id,
    pack_no: Number(id),
    slot: 1,
    edition_key: null,
    player_name: null,
    set_name: null,
    team_name: null,
    tier: null,
    serial_number: null,
    fmv_usd: 1,
    image_url: null,
    delivered_at: null,
    last_checked_at: null,
    last_check_recipient_holds: null,
    last_check_admin_holds: null,
    source_wallet: VAULT,
    funded_from: "0x00000000000000aa",
    ...over,
  }
}

function fakeDb(opts: { pool?: PoolRow[]; rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null } } = {}) {
  const updates: Array<{ payload: unknown; ids: unknown }> = []
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
  const db = {
    from() {
      let payload: unknown = null
      let ids: unknown = null
      const b = {
        select: () => b,
        update: (p: unknown) => ((payload = p), b),
        eq: () => b,
        in: (_k: string, v: unknown) => ((ids = v), b),
        order: () => b,
        limit: () => b,
        then: (res: (r: unknown) => unknown) => {
          if (payload) updates.push({ payload, ids })
          return Promise.resolve(payload ? { data: null, error: null } : { data: opts.pool ?? [], error: null }).then(res)
        },
      }
      return b
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args })
      return Promise.resolve(opts.rpc ? opts.rpc(name, args) : { data: null, error: null })
    },
  }
  return { db: db as unknown as SupabaseClient, updates, rpcs }
}

const boolArr = (n: number, v = true): CdcValue => ({ type: "Array", value: Array.from({ length: n }, () => ({ type: "Bool", value: v })) })

describe("giveaways/vault — configuration and the switch", () => {
  it("needs all three key vars, well-formed, and the switch, before anything is enabled", () => {
    expect(vaultConfig(ENV)).toEqual({ addr: VAULT, pk: KEY, keyIndex: 0 })
    expect(instantDeliveryEnabled(ENV)).toBe(true)
    expect(instantDeliveryEnabled({ ...ENV, RPC_GIVEAWAY_INSTANT_DELIVERY: "0" })).toBe(false)
    expect(vaultConfig({ ...ENV, GIVEAWAY_VAULT_PRIVATE_KEY: "nothex" })).toBeNull()
    expect(vaultConfig({ ...ENV, GIVEAWAY_VAULT_ADDR: "0x123" })).toBeNull()
    expect(vaultConfig({ ...ENV, GIVEAWAY_VAULT_KEY_INDEX: "-1" })).toBeNull()
    expect(vaultConfig({ ...ENV, GIVEAWAY_VAULT_ADDR: VAULT.toUpperCase().replace("0X", "0x"), GIVEAWAY_VAULT_PRIVATE_KEY: `0x${KEY}` })?.addr).toBe(VAULT)
  })

  it("status reads the chain only when configured, and never returns the key", async () => {
    const run = vi.fn(async () => ({ type: "Array", value: ["-1", "5.001", "3363", "500100000"].map((v) => ({ type: "String", value: v })) }))
    const s = await vaultStatus(run, ENV)
    expect(run).toHaveBeenCalledWith(VAULT_STATUS_SCRIPT, [{ type: "Address", value: VAULT }])
    expect(s).toEqual({ configured: true, enabled: true, address: VAULT, topshot_held: null, flow_balance: "5.001", storage_used: 3363, storage_capacity: 500100000 })
    expect(JSON.stringify(s)).not.toContain(KEY)
    const off = await vaultStatus(run, {} as NodeJS.ProcessEnv)
    expect(off).toMatchObject({ configured: false, enabled: false, address: null })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("nothing signs when switched off or unconfigured", async () => {
    const submit = vi.fn()
    await expect(setUpVault({ env: { ...ENV, RPC_GIVEAWAY_INSTANT_DELIVERY: "" }, submit })).rejects.toMatchObject({ code: "vault_disabled" })
    await expect(sendFromVault(fakeDb().db, DROP, {}, { env: {} as NodeJS.ProcessEnv, submit })).rejects.toMatchObject({ code: "vault_unconfigured" })
    expect(submit).not.toHaveBeenCalled()
  })
})

describe("giveaways/vault — setup", () => {
  it("simulates, then signs the setup once; a vault with a collection is left alone", async () => {
    const status = (held: string): CdcValue => ({ type: "Array", value: [held, "5", "1", "2"].map((v) => ({ type: "String", value: v })) })
    const submit = vi.fn(async (_code: string, _args?: unknown) => "f".repeat(64))
    const run = vi.fn(async (script: string) => (script === VAULT_STATUS_SCRIPT ? status("-1") : { type: "Bool", value: true }))
    expect(await setUpVault({ env: ENV, run, submit })).toBe("f".repeat(64))
    expect(run.mock.calls.map((c) => c[0])).toEqual([VAULT_STATUS_SCRIPT, VAULT_SETUP_SIMULATION_SCRIPT])
    expect(submit.mock.calls[0][0]).toBe(VAULT_SETUP_CADENCE)
    const has = vi.fn(async () => status("0"))
    expect(await setUpVault({ env: ENV, run: has, submit })).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
    const bad = vi.fn(async (script: string) => (script === VAULT_STATUS_SCRIPT ? status("-1") : { type: "Bool", value: false }))
    await expect(setUpVault({ env: ENV, run: bad, submit })).rejects.toMatchObject({ code: "simulation_failed" })
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe("giveaways/vault — funding", () => {
  const held = (ids: string[], locked = false): Record<string, Holding> => Object.fromEntries(ids.map((id) => [id, { held: true, locked }]))

  it("records the drop funded only when the vault holds the whole undelivered pool, unlocked", async () => {
    const pool = [pm("1", { source_wallet: "0x00000000000000aa" }), pm("2", { source_wallet: "0x00000000000000aa" }), pm("3", { delivered_at: "x" })]
    const f = fakeDb({ pool, rpc: () => ({ data: 2, error: null }) })
    await expect(confirmFunding(f.db, DROP, { env: ENV, read: async () => held(["1"]) })).rejects.toMatchObject({ code: "vault_incomplete", message: expect.stringContaining("2") })
    await expect(confirmFunding(f.db, DROP, { env: ENV, read: async () => held(["1", "2"], true) })).rejects.toMatchObject({ code: "vault_locked" })
    expect(f.rpcs).toHaveLength(0)
    const read = vi.fn(async () => held(["1", "2"]))
    expect(await confirmFunding(f.db, DROP, { env: ENV, read })).toEqual({ moved: 2 })
    expect(read).toHaveBeenCalledWith(VAULT, ["1", "2"])
    expect(f.rpcs).toEqual([{ name: "mark_giveaway_vault_funded", args: { p_drop_id: DROP.id, p_vault: VAULT } }])
    await expect(confirmFunding(f.db, { ...DROP, status: "closed" }, { env: ENV, read })).rejects.toMatchObject({ code: "wrong_status" })
  })
})

describe("giveaways/vault — sending", () => {
  const reserved = [
    { moment_id: "1", recipient: "0x0000000000000011" },
    { moment_id: "2", recipient: "0x0000000000000022" },
  ]

  it("sends exactly what the database reserved, to the reserved recipients, after a passing simulation", async () => {
    const f = fakeDb({ pool: [], rpc: (name) => (name === "reserve_giveaway_vault_send" ? { data: reserved, error: null } : { data: null, error: null }) })
    const run = vi.fn(async (_script: string, _args?: unknown) => boolArr(2))
    const submit = vi.fn(async (_code: string, _args?: unknown) => "e".repeat(64))
    const r = await sendFromVault(f.db, DROP, { packNo: 1 }, { env: ENV, run, submit })
    expect(f.rpcs[0]).toEqual({ name: "reserve_giveaway_vault_send", args: { p_drop_id: DROP.id, p_pack_no: 1, p_return: false } })
    expect(run.mock.calls[0][0]).toBe(DELIVER_OWN_SIMULATION_SCRIPT)
    expect(JSON.stringify(run.mock.calls[0][1])).toContain(VAULT)
    expect(submit.mock.calls[0][0]).toBe(DELIVER_OWN_BATCH_CADENCE)
    // the args the vault signs are the reserved ids and recipients, nothing else
    const argFn = submit.mock.calls[0][1] as unknown as (arg: (v: unknown) => unknown, types: { Array: (x: unknown) => unknown; UInt64: string; Address: string }) => unknown[]
    expect(argFn((v) => v, { Array: (x) => x, UInt64: "u", Address: "a" })).toEqual([["1", "2"], ["0x0000000000000011", "0x0000000000000022"]])
    expect(r).toMatchObject({ reserved: 2, sent: 2, tx_ids: ["e".repeat(64)], unknown: [], failed: [] })
    expect(f.updates[0]).toEqual({ payload: { delivery_tx_id: "e".repeat(64), delivery_error: null }, ids: ["1", "2"] })
  })

  it("a simulation that doesn't land every Moment signs nothing and records why", async () => {
    const f = fakeDb({ rpc: () => ({ data: reserved, error: null }) })
    const submit = vi.fn()
    const r = await sendFromVault(f.db, DROP, {}, { env: ENV, run: async () => ({ type: "Array", value: [{ type: "Bool", value: true }, { type: "Bool", value: false }] }), submit })
    expect(submit).not.toHaveBeenCalled()
    expect(r.failed[0].moment_ids).toEqual(["1", "2"])
    expect((f.updates[0].payload as { delivery_error: string }).delivery_error).toMatch(/simulated transfer/)
  })

  it("a seal that wasn't read in time is UNCONFIRMED, never 'not sent'", async () => {
    const f = fakeDb({ rpc: () => ({ data: reserved, error: null }) })
    const r = await sendFromVault(f.db, DROP, {}, {
      env: ENV,
      run: async () => boolArr(2),
      submit: async () => {
        throw new VaultSealUnknownError("d".repeat(64))
      },
    })
    expect(r).toMatchObject({ sent: 0, unknown: ["d".repeat(64)], failed: [] })
    expect(f.updates[0].payload).toEqual({ delivery_tx_id: "d".repeat(64), delivery_error: "seal not read in time; Verify reads the chain" })
  })

  it("refuses a drop whose pool is not in THIS vault, and an empty reservation sends nothing", async () => {
    await expect(sendFromVault(fakeDb().db, { ...DROP, vault_address: null }, {}, { env: ENV })).rejects.toMatchObject({ code: "not_funded" })
    const submit = vi.fn()
    const r = await sendFromVault(fakeDb({ rpc: () => ({ data: [], error: null }) }).db, DROP, {}, { env: ENV, submit })
    expect(r.reserved).toBe(0)
    expect(submit).not.toHaveBeenCalled()
  })

  it("a refused reservation (22023) is the operator's own copy", async () => {
    const f = fakeDb({ rpc: () => ({ data: null, error: { message: "giveaway: unclaimed Moments go back only after the drop closes", code: "22023" } }) })
    await expect(sendFromVault(f.db, DROP, { returnUnclaimed: true }, { env: ENV })).rejects.toMatchObject({ code: "refused", message: expect.stringContaining("after the drop closes") })
  })

  it("a return, once landed, points each Moment's source back home", async () => {
    const pool = [pm("1"), pm("2", { funded_from: "0x00000000000000bb" })]
    const f = fakeDb({ pool, rpc: () => ({ data: [{ moment_id: "1", recipient: "0x00000000000000aa" }, { moment_id: "2", recipient: "0x00000000000000bb" }], error: null }) })
    const read = vi.fn(async (_a: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])))
    const r = await sendFromVault(f.db, { ...DROP, status: "closed" }, { returnUnclaimed: true }, { env: ENV, run: async () => boolArr(2), submit: async () => "c".repeat(64), read })
    expect(r.sent).toBe(2)
    const homes = f.updates.filter((u) => (u.payload as { source_wallet?: string }).source_wallet)
    expect(homes.map((u) => [(u.payload as { source_wallet: string }).source_wallet, u.ids])).toEqual([
      ["0x00000000000000aa", ["1"]],
      ["0x00000000000000bb", ["2"]],
    ])
  })

  // 2026-11-13 (review): an UNCONFIRMED return (seal not read in time) skipped markReturned, and a retry fails at
  // simulation (the vault no longer holds it) — so the row pointed at the vault forever. It reads the chain itself.
  it("a return whose seal wasn't read in time still points each Moment home once the chain shows it there", async () => {
    const pool = [pm("1"), pm("2", { funded_from: "0x00000000000000bb" })]
    const f = fakeDb({ pool, rpc: () => ({ data: [{ moment_id: "1", recipient: "0x00000000000000aa" }, { moment_id: "2", recipient: "0x00000000000000bb" }], error: null }) })
    const read = vi.fn(async (_a: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { held: true, locked: false }])))
    const r = await sendFromVault(f.db, { ...DROP, status: "closed" }, { returnUnclaimed: true }, {
      env: ENV, run: async () => boolArr(2), read,
      submit: async () => {
        throw new VaultSealUnknownError("e".repeat(64))
      },
    })
    expect(r.sent).toBe(0)
    const homes = f.updates.filter((u) => (u.payload as { source_wallet?: string }).source_wallet)
    expect(homes.map((u) => (u.payload as { source_wallet: string }).source_wallet).sort()).toEqual(["0x00000000000000aa", "0x00000000000000bb"])
  })

  it("markReturned leaves a Moment that hasn't arrived home pointed at the vault", async () => {
    const f = fakeDb({ pool: [pm("1")] })
    expect(await markReturned(f.db, DROP, { read: async () => ({ "1": { held: false, locked: null } }) })).toEqual({ returned: 0 })
    expect(f.updates).toHaveLength(0)
  })
})
