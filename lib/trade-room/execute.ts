// lib/trade-room/execute.ts
//
// The CHAIN half of a trade room, built on the admin swap test (lib/swap-test):
// the same simulate-then-sign plan, the same two-authorizer transaction, the same
// co-signer relay — with the room's two sides as the two signers. RPC never holds a
// key, a moment or a fee.
//
// ⛔ THE SIGNING STEP IS GATED. The live two-signer run (/admin/swap-test, Trevor's
// own wallets) has not sealed yet (2026-10-31), so no user wallet is asked to sign
// until RPC_TRADE_ROOM_EXECUTE=1 is set in production. Everything before that step
// — chain checks of each pick, the mainnet simulation of the whole swap — is a READ
// and runs now, so a room can reach "accepted" and be proven executable.

import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { planSwap, SwapTestError, verifySwap, type LandedMoment, type PlanDeps, type SwapPlan } from "@/lib/swap-test/plan"
import { TradeRoomError, otherSide, type LoadedRoom, type Side, type SideRow } from "@/lib/trade-room/store"

export const EXECUTE_FLAG = "RPC_TRADE_ROOM_EXECUTE"

/** True only when production has opened the on-chain step. */
export function executionOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env[EXECUTE_FLAG] === "1"
}

export const EXECUTE_CLOSED_MESSAGE =
  "The on-chain step isn't open yet: trades are saved and accepted here, and signing opens once RPC's live two-wallet test has sealed. Nothing has moved."

/** A chain read that could not complete: never "not held", never "locked". */
export function chainUnavailable(e: unknown): TradeRoomError {
  return new TradeRoomError(`We couldn't reach the Flow blockchain to check those Moments (${e instanceof Error ? e.message : String(e)}). Try again in a minute.`, 503, "upstream_unavailable")
}

/**
 * Every id must be held by `source` and unlocked, read from the chain now. A
 * failed read throws the 503 above; a pick that fails the check is named.
 */
export async function checkPicks(source: string, ids: readonly string[], read: (a: string, i: string[]) => Promise<Record<string, Holding>> = readTopShotHoldings): Promise<void> {
  if (ids.length === 0) return
  let holdings: Record<string, Holding>
  try {
    holdings = await read(source, [...ids])
  } catch (e) {
    throw chainUnavailable(e)
  }
  const missing = ids.filter((id) => !holdings[id]?.held)
  if (missing.length) throw new TradeRoomError(`${source} doesn't hold ${missing.join(", ")} right now.`, 409, "not_held")
  const locked = ids.filter((id) => holdings[id]?.locked !== false)
  if (locked.length) throw new TradeRoomError(`Locked on Top Shot (unlock first): ${locked.join(", ")}.`, 409, "locked")
}

function sideInput(loaded: LoadedRoom, side: SideRow) {
  return {
    signer: side.signer,
    source: side.source,
    ids: loaded.items.filter((i) => i.side === side.side).map((i) => i.moment_id),
  }
}

/**
 * The swap plan with `initiator` as plan.a (its wallet submits; the other side
 * co-signs). Simulated on mainnet by planSwap — a plan comes back only when every
 * moment lands. Requires both sides proven and the room accepted or signing.
 */
export async function planRoom(loaded: LoadedRoom, initiator: Side, deps: PlanDeps = {}): Promise<SwapPlan> {
  if (loaded.room.status !== "accepted" && loaded.room.status !== "signing") {
    throw new TradeRoomError("Both sides must accept the trade before it can be simulated.", 409, "not_accepted")
  }
  const a = loaded.sides.find((s) => s.side === initiator)
  const b = loaded.sides.find((s) => s.side === otherSide(initiator))
  if (!a?.signer || !a.source || !b?.signer || !b.source) throw new TradeRoomError("Both sides need a proven Flow Wallet.", 409, "no_wallet")
  try {
    return await planSwap(sideInput(loaded, a), sideInput(loaded, b), deps)
  } catch (e) {
    if (e instanceof SwapTestError) throw new TradeRoomError(e.message, e.status, e.code)
    throw e
  }
}

/** After a seal: where each moment is now, read from the chain (a failed read throws). */
export async function verifyRoom(loaded: LoadedRoom, deps: Pick<PlanDeps, "read"> = {}): Promise<LandedMoment[]> {
  const a = loaded.sides.find((s) => s.side === "a")
  const b = loaded.sides.find((s) => s.side === "b")
  if (!a?.signer || !a.source || !b?.signer || !b.source) throw new TradeRoomError("Both sides need a proven Flow Wallet.", 409, "no_wallet")
  try {
    return await verifySwap({ a: sideInput(loaded, a), b: sideInput(loaded, b) }, deps)
  } catch (e) {
    if (e instanceof SwapTestError) throw new TradeRoomError(e.message, e.status, e.code)
    throw e
  }
}
