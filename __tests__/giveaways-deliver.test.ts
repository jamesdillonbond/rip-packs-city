import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { chunk, nothingSendable, planDelivery } from "@/lib/giveaways/deliver"
import { DELIVER_OWN_SIMULATION_SCRIPT, DELIVER_SIMULATION_SCRIPT, PROVIDER_CONTROLLERS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import type { CdcArg, CdcValue } from "@/lib/giveaways/flow-script"
import type { DropRow } from "@/lib/giveaways/store"
import type { Holding } from "@/lib/giveaways/topshot-holdings"

const DROP: DropRow = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "d",
  title: "D",
  description: null,
  sponsor_name: "T",
  collection_id: "c",
  admin_wallet: "0x00000000000000aa",
  status: "open",
  pack_count: 2,
  moments_per_pack: 2,
  seal_hash: "a".repeat(64),
  seal_salt: "b".repeat(64),
  sealed_at: "t",
  opened_at: "t",
  closed_at: null,
  created_at: "t",
}
const PARENT = "0x00000000000000bb"

function db(pool: unknown[], claims: unknown[]) {
  return {
    from(table: string) {
      const b = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () => b,
        then: (res: (r: unknown) => unknown) => Promise.resolve({ data: table === "giveaway_claims" ? claims : pool, error: null }).then(res),
      }
      return b
    },
  } as unknown as SupabaseClient
}

const pm = (id: string, pack: number, slot: number, delivered_at: string | null = null, source_wallet = "0x00000000000000aa") => ({
  moment_id: id,
  pack_no: pack,
  slot,
  fmv_usd: 1,
  delivered_at,
  source_wallet,
})
const POOL = [pm("4", 2, 2), pm("1", 1, 1), pm("2", 1, 2), pm("3", 2, 1, "2026-09-29T20:00:00Z")]
const CLAIMS = [
  { pack_no: 1, user_id: "u1", topshot_username: "a", recipient_address: "0x0000000000000001", claimed_at: "t" },
  { pack_no: 2, user_id: "u2", topshot_username: "b", recipient_address: "0x0000000000000002", claimed_at: "t" },
]
const held = (locked: Record<string, boolean> = {}, missing: string[] = []) =>
  vi.fn(async (_a: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, missing.includes(id) ? { held: false, locked: null } : { held: true, locked: locked[id] ?? false }])) as Record<string, Holding>,
  )
const arr = (type: string, vs: unknown[]): CdcValue => ({ type: "Array", value: vs.map((value) => ({ type, value })) })

function runner(controllers: string[], sim: (ids: string[]) => boolean[] = (ids) => ids.map(() => true)) {
  return vi.fn(async (script: string, args: CdcArg[]) => {
    if (script === PROVIDER_CONTROLLERS_SCRIPT) return arr("UInt64", controllers)
    if (script === DELIVER_SIMULATION_SCRIPT || script === DELIVER_OWN_SIMULATION_SCRIPT) {
      const at = script === DELIVER_SIMULATION_SCRIPT ? 3 : 1
      const ids = ((args[at] as { value: CdcArg[] }).value as { value: string }[]).map((a) => a.value)
      return arr("Bool", sim(ids))
    }
    throw new Error("unexpected script")
  })
}

describe("giveaways/deliver — planDelivery", () => {
  it("plans every claimed, undelivered moment in pack/slot order, simulated before it is offered", async () => {
    const run = runner(["70", "4"])
    const read = held()
    const plan = await planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read, run })
    expect(plan).toEqual({
      parent: PARENT,
      batches: [
        {
          source: "0x00000000000000aa",
          kind: "linked",
          providerControllerID: "70",
          momentIDs: ["1", "2", "4"],
          recipients: ["0x0000000000000001", "0x0000000000000001", "0x0000000000000002"],
        },
      ],
      skipped: [],
    })
    // delivered moment 3 is never re-sent; the simulation ran with the planned batch
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["1", "2", "4"])
    const simCall = run.mock.calls.find((c) => c[0] === DELIVER_SIMULATION_SCRIPT)!
    expect(simCall[1][0]).toEqual({ type: "Address", value: PARENT })
    expect(simCall[1][2]).toEqual({ type: "UInt64", value: "70" })
  })

  it("an unclaimed pack is not delivered", async () => {
    const plan = await planDelivery(db(POOL, [CLAIMS[1]]), DROP, PARENT, { read: held(), run: runner(["70"]) })
    expect(plan.batches[0].momentIDs).toEqual(["4"])
  })

  it("skips moved or locked moments and says why", async () => {
    const plan = await planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held({ "2": true }, ["4"]), run: runner(["70"]) })
    expect(plan.batches[0].momentIDs).toEqual(["1"])
    expect(plan.skipped).toEqual([
      { moment_id: "2", reason: "locked" },
      { moment_id: "4", reason: "not_held" },
    ])
  })

  it("an all-sent-but-unverified drop is not called 'moved or locked' (2026-10-03)", async () => {
    const err = await planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held({}, ["1", "2", "4"]), run: runner(["70"]) }).catch((e) => e)
    expect(err).toMatchObject({ code: "nothing_to_deliver" })
    expect(err.message).toContain("Verify deliveries")
    expect(err.message).not.toMatch(/moved|locked/)
  })

  it("names locked and missing counts separately when nothing can be sent", () => {
    expect(nothingSendable([{ moment_id: "1", reason: "locked" }])).toMatch(/^All 1 claimed moment\(s\) still in your account are locked/)
    const mixed = nothingSendable([
      { moment_id: "1", reason: "locked" },
      { moment_id: "2", reason: "not_held" },
      { moment_id: "3", reason: "not_held" },
    ])
    expect(mixed).toContain("2 no longer in your account")
    expect(mixed).toContain("1 locked on chain")
  })

  it("splits into batches of at most 50", async () => {
    const pool = Array.from({ length: 60 }, (_, i) => pm(String(i + 1), 1, i + 1))
    const plan = await planDelivery(db(pool, [CLAIMS[0]]), { ...DROP, pack_count: 1, moments_per_pack: 60 }, PARENT, { read: held(), run: runner(["70"]) })
    expect(plan.batches.map((b) => b.momentIDs.length)).toEqual([50, 10])
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })

  it("refuses a wallet that cannot withdraw from the account (no resolvable controller)", async () => {
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held(), run: runner([]) })).rejects.toMatchObject({ code: "not_parent" })
  })

  it("refuses to offer a batch whose simulation did not land every moment", async () => {
    const run = runner(["70"], (ids) => ids.map((id) => id !== "2"))
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held(), run })).rejects.toMatchObject({ code: "simulation_failed" })
  })

  it("a simulation panic propagates (the route shows its message)", async () => {
    const run = vi.fn(async (script: string) => {
      if (script === PROVIDER_CONTROLLERS_SCRIPT) return arr("UInt64", ["70"])
      throw new Error("Cadence: Cannot withdraw: Moment is locked")
    })
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held(), run })).rejects.toThrow("Moment is locked")
  })

  it("a malformed chain answer is an error, never an empty plan", async () => {
    const run = vi.fn(async () => ({ type: "Dictionary", value: [] }) as CdcValue)
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held(), run })).rejects.toMatchObject({ code: "flow_shape" })
    const run2 = vi.fn(async (script: string) => (script === PROVIDER_CONTROLLERS_SCRIPT ? arr("UInt64", ["70"]) : ({ type: "Bool", value: true } as CdcValue)))
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read: held(), run: run2 })).rejects.toMatchObject({ code: "flow_shape" })
  })

  it("refuses bad input and states with nothing to send", async () => {
    const deps = { read: held(), run: runner(["70"]) }
    await expect(planDelivery(db(POOL, CLAIMS), DROP, "0xnope", deps)).rejects.toMatchObject({ code: "bad_parent" })
    await expect(planDelivery(db(POOL, CLAIMS), { ...DROP, status: "sealed" }, PARENT, deps)).rejects.toMatchObject({ code: "wrong_status" })
    await expect(planDelivery(db([pm("3", 2, 1, "t")], CLAIMS), DROP, PARENT, deps)).rejects.toMatchObject({ code: "nothing_to_deliver" })
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { ...deps, read: held({}, ["1", "2", "4"]) })).rejects.toMatchObject({
      code: "nothing_to_deliver",
    })
    // a closed drop can still be delivered
    expect((await planDelivery(db(POOL, CLAIMS), { ...DROP, status: "closed" }, PARENT, deps)).batches).toHaveLength(1)
  })

  it("a pool across the Flow Wallet and a linked account plans one batch per source, each simulated its own way (2026-10-03)", async () => {
    const mixed = [pm("1", 1, 1, null, PARENT), pm("2", 1, 2), pm("4", 2, 2, null, PARENT)]
    const run = runner(["70"])
    const read = held()
    const plan = await planDelivery(db(mixed, CLAIMS), { ...DROP, admin_wallet: PARENT }, PARENT, { read, run })
    expect(plan.batches).toEqual([
      { source: PARENT, kind: "own", providerControllerID: null, momentIDs: ["1", "4"], recipients: ["0x0000000000000001", "0x0000000000000002"] },
      { source: "0x00000000000000aa", kind: "linked", providerControllerID: "70", momentIDs: ["2"], recipients: ["0x0000000000000001"] },
    ])
    // holdings are read from each moment's own source
    expect(read).toHaveBeenCalledWith(PARENT, ["1", "4"])
    expect(read).toHaveBeenCalledWith("0x00000000000000aa", ["2"])
    // the own batch is simulated from the wallet's own collection; no controller lookup for it
    const ownSim = run.mock.calls.find((c) => c[0] === DELIVER_OWN_SIMULATION_SCRIPT)!
    expect(ownSim[1][0]).toEqual({ type: "Address", value: PARENT })
    expect(run.mock.calls.filter((c) => c[0] === PROVIDER_CONTROLLERS_SCRIPT).map((c) => c[1][1])).toEqual([{ type: "Address", value: "0x00000000000000aa" }])
  })

  it("a failed chain read plans nothing (never a plan built on a read that didn't happen)", async () => {
    const read = vi.fn(async () => Promise.reject(new Error("Flow script HTTP 500")))
    await expect(planDelivery(db(POOL, CLAIMS), DROP, PARENT, { read, run: runner(["70"]) })).rejects.toMatchObject({ code: "chain_read_failed", status: 502 })
  })
})
