// lib/giveaways/deliver.ts
//
// Planning a one-signature delivery. Server-only; RPC signs nothing. The plan
// names the admin's parent wallet, the linked (Dapper) account the moments sit
// in, the withdraw capability to use, and the batches — and every batch has
// already been SIMULATED against live mainnet state (DELIVER_SIMULATION_SCRIPT
// runs the exact withdraw → deposit in memory), so the admin is only ever asked
// to sign a transaction that just worked.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DELIVER_SIMULATION_SCRIPT,
  MAX_DELIVERY_BATCH,
  PROVIDER_CONTROLLERS_SCRIPT,
} from "@/lib/giveaways/deliver-cadence"
import { addr, arrayOf, runFlowScript, u64, type CdcValue } from "@/lib/giveaways/flow-script"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { getClaims, getPool, GiveawayError, type DropRow } from "@/lib/giveaways/store"

export interface DeliveryBatch {
  momentIDs: string[]
  recipients: string[]
}

export interface DeliveryPlan {
  parent: string
  child: string
  providerControllerID: string
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
  if (parent === drop.admin_wallet) {
    throw new GiveawayError("Connect the Flow Wallet LINKED to this account, not the account itself.", 400, "bad_parent")
  }

  const [pool, claims] = await Promise.all([getPool(db, drop.id), getClaims(db, drop.id)])
  const recipientByPack = new Map(claims.map((c) => [c.pack_no, c.recipient_address]))
  const pending = pool
    .filter((m) => m.pack_no != null && recipientByPack.has(m.pack_no) && m.delivered_at == null)
    .sort((a, b) => (a.pack_no ?? 0) - (b.pack_no ?? 0) || (a.slot ?? 0) - (b.slot ?? 0))
  if (pending.length === 0) throw new GiveawayError("Every claimed moment is already delivered.", 409, "nothing_to_deliver")

  const holdings = await read(drop.admin_wallet, pending.map((m) => m.moment_id))
  const skipped: DeliveryPlan["skipped"] = []
  const ready = pending.filter((m) => {
    const h = holdings[m.moment_id]
    if (!h?.held) skipped.push({ moment_id: m.moment_id, reason: "not_held" })
    else if (h.locked !== false) skipped.push({ moment_id: m.moment_id, reason: "locked" })
    else return true
    return false
  })
  if (ready.length === 0) throw new GiveawayError(nothingSendable(skipped), 409, "nothing_to_deliver")

  const controllers = uintArray(await run(PROVIDER_CONTROLLERS_SCRIPT, [addr(parent), addr(drop.admin_wallet)]))
  if (controllers.length === 0) {
    throw new GiveawayError(`${parent} cannot withdraw from ${drop.admin_wallet}: connect a Flow Wallet linked to that account.`, 409, "not_parent")
  }
  const providerControllerID = controllers[0]

  const batches = chunk(ready, MAX_DELIVERY_BATCH).map((b) => ({
    momentIDs: b.map((m) => m.moment_id),
    recipients: b.map((m) => recipientByPack.get(m.pack_no as number) as string),
  }))
  for (const [i, b] of batches.entries()) {
    const ok = boolArray(
      await run(DELIVER_SIMULATION_SCRIPT, [
        addr(parent),
        addr(drop.admin_wallet),
        u64(providerControllerID),
        arrayOf(b.momentIDs.map(u64)),
        arrayOf(b.recipients.map(addr)),
      ]),
    )
    if (ok.length !== b.momentIDs.length || ok.some((x) => !x)) {
      throw new GiveawayError(`Batch ${i + 1}: the simulated transfer did not land every moment; not asking you to sign it.`, 409, "simulation_failed")
    }
  }
  return { parent, child: drop.admin_wallet, providerControllerID, batches, skipped }
}
