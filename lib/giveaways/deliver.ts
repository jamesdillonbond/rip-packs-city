// lib/giveaways/deliver.ts
//
// Planning a one-signature delivery. Server-only; RPC signs nothing. The plan
// names the admin's connected Flow Wallet and the batches; every batch has
// already been SIMULATED against live mainnet state, so the admin is only ever
// asked to sign a transaction that just worked.
//
// A pool can span the Flow Wallet and the accounts it has linked (2026-10-03),
// so batches are per SOURCE account:
//   kind "own"    — moments in the connected Flow Wallet itself; it withdraws
//                   from its own collection (DELIVER_OWN_*).
//   kind "linked" — moments in a Hybrid Custody child (e.g. the Dapper account);
//                   the Flow Wallet withdraws through its child capability
//                   (DELIVER_BATCH_CADENCE / DELIVER_SIMULATION_SCRIPT).

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DELIVER_OWN_SIMULATION_SCRIPT,
  DELIVER_SIMULATION_SCRIPT,
  MAX_DELIVERY_BATCH,
  PROVIDER_CONTROLLERS_SCRIPT,
} from "@/lib/giveaways/deliver-cadence"
import { addr, arrayOf, runFlowScript, u64, type CdcValue } from "@/lib/giveaways/flow-script"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { bySource, getClaims, getPool, GiveawayError, readHoldingsBySource, type DropRow } from "@/lib/giveaways/store"

export interface DeliveryBatch {
  /** The account the moments leave from. */
  source: string
  kind: "own" | "linked"
  /** Set for kind "linked": the child's withdraw capability the parent uses. */
  providerControllerID: string | null
  momentIDs: string[]
  recipients: string[]
}

export interface DeliveryPlan {
  parent: string
  batches: DeliveryBatch[]
  /** Claimed, undelivered moments left out, and why. */
  skipped: { moment_id: string; reason: "not_held" | "locked" }[]
}

export interface DeliverDeps {
  read?: (address: string, ids: string[]) => Promise<Record<string, Holding>>
  run?: typeof runFlowScript
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function uintArray(v: CdcValue): string[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new GiveawayError("The controller lookup returned an unexpected shape.", 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => String(x.value))
}

function boolArray(v: CdcValue): boolean[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new GiveawayError("The delivery simulation returned an unexpected shape.", 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => x.value === true)
}

/**
 * Why a plan has nothing to send, by reason. A moment no longer in the admin's
 * account is usually one ALREADY SENT whose delivery Verify has not stamped yet;
 * calling that "moved or locked" told Trevor his finished drop had failed
 * (2026-10-03, after all 8 test1 moments arrived).
 */
export function nothingSendable(skipped: DeliveryPlan["skipped"]): string {
  const gone = skipped.filter((s) => s.reason === "not_held").length
  const locked = skipped.filter((s) => s.reason === "locked").length
  if (locked === 0) {
    return "None of the claimed moments are still in your account. If they were already sent, click Verify deliveries to mark them delivered."
  }
  if (gone === 0) {
    return `All ${locked} claimed moment(s) still in your account are locked on chain; unlock them in Top Shot, then try again.`
  }
  return `Nothing can be sent right now: ${gone} no longer in your account (already sent? click Verify deliveries), ${locked} locked on chain.`
}

export async function planDelivery(db: SupabaseClient, drop: DropRow, parent: string, deps: DeliverDeps = {}): Promise<DeliveryPlan> {
  const read = deps.read ?? readTopShotHoldings
  const run = deps.run ?? runFlowScript
  if (!/^0x[0-9a-f]{16}$/.test(parent)) throw new GiveawayError("The connected wallet address is not a Flow address.", 400, "bad_parent")
  if (drop.status !== "open" && drop.status !== "closed") {
    throw new GiveawayError(`Nothing to deliver on a ${drop.status} drop.`, 409, "wrong_status")
  }

  const [pool, claims] = await Promise.all([getPool(db, drop.id), getClaims(db, drop.id)])
  const recipientByPack = new Map(claims.map((c) => [c.pack_no, c.recipient_address]))
  const pending = pool
    .filter((m) => m.pack_no != null && recipientByPack.has(m.pack_no) && m.delivered_at == null)
    .sort((a, b) => (a.pack_no ?? 0) - (b.pack_no ?? 0) || (a.slot ?? 0) - (b.slot ?? 0))
  if (pending.length === 0) throw new GiveawayError("Every claimed moment is already delivered.", 409, "nothing_to_deliver")

  const { holdings, failed } = await readHoldingsBySource(pending, drop.admin_wallet, read)
  if (failed.length) {
    throw new GiveawayError(`Couldn't read the chain for ${failed.join(", ")}; nothing was planned. Try again.`, 502, "chain_read_failed")
  }
  const skipped: DeliveryPlan["skipped"] = []
  const ready = pending.filter((m) => {
    const h = holdings[m.moment_id]
    if (!h?.held) skipped.push({ moment_id: m.moment_id, reason: "not_held" })
    else if (h.locked !== false) skipped.push({ moment_id: m.moment_id, reason: "locked" })
    else return true
    return false
  })
  if (ready.length === 0) throw new GiveawayError(nothingSendable(skipped), 409, "nothing_to_deliver")

  const batches: DeliveryBatch[] = []
  for (const [source, moments] of bySource(ready, drop.admin_wallet)) {
    let kind: DeliveryBatch["kind"] = "own"
    let providerControllerID: string | null = null
    if (source !== parent) {
      kind = "linked"
      const controllers = uintArray(await run(PROVIDER_CONTROLLERS_SCRIPT, [addr(parent), addr(source)]))
      if (controllers.length === 0) {
        throw new GiveawayError(`${parent} cannot withdraw from ${source}: connect the Flow Wallet linked to that account.`, 409, "not_parent")
      }
      providerControllerID = controllers[0]
    }
    for (const part of chunk(moments, MAX_DELIVERY_BATCH)) {
      batches.push({
        source,
        kind,
        providerControllerID,
        momentIDs: part.map((m) => m.moment_id),
        recipients: part.map((m) => recipientByPack.get(m.pack_no as number) as string),
      })
    }
  }

  for (const [i, b] of batches.entries()) {
    const sim =
      b.kind === "own"
        ? await run(DELIVER_OWN_SIMULATION_SCRIPT, [addr(parent), arrayOf(b.momentIDs.map(u64)), arrayOf(b.recipients.map(addr))])
        : await run(DELIVER_SIMULATION_SCRIPT, [
            addr(parent),
            addr(b.source),
            u64(b.providerControllerID as string),
            arrayOf(b.momentIDs.map(u64)),
            arrayOf(b.recipients.map(addr)),
          ])
    const ok = boolArray(sim)
    if (ok.length !== b.momentIDs.length || ok.some((x) => !x)) {
      throw new GiveawayError(`Batch ${i + 1}: the simulated transfer did not land every moment; not asking you to sign it.`, 409, "simulation_failed")
    }
  }
  return { parent, batches, skipped }
}
