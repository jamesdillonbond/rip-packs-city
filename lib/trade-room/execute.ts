// lib/trade-room/execute.ts
//
// The CHAIN half of a trade room, built on the admin swap test (lib/swap-test) — and, for
// rooms holding NFL All Day / LaLiga Golazos / UFC Strike (2026-11-02), lib/trade-room/multi-plan.ts:
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
import { planMultiSwap, readCanReceive, readCollectionHoldings, verifyMultiSwap, type LandedPick, type MultiDeps, type MultiPlan, type MultiSideInput, type Pick } from "@/lib/trade-room/multi-plan"
import { SWAP_COLLECTIONS, swapCollection, swapCollectionByDbSlug } from "@/lib/trade-room/multi-swap-cadence"
import { runFlowScript } from "@/lib/giveaways/flow-script"

export const EXECUTE_FLAG = "RPC_TRADE_ROOM_EXECUTE"

/** True only when production has opened the on-chain step. */
export function executionOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env[EXECUTE_FLAG] === "1"
}

export const EXECUTE_CLOSED_MESSAGE =
  "Signing is paused on RPC right now: trades can still be built and accepted here, but no wallet is asked to sign. Nothing has moved."

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

/**
 * Multi-collection picks (2026-11-02): every pick must be held by `source` (and, for Top Shot,
 * unlocked), read from the chain now, per collection. A failed read throws the 503 above.
 */
export async function checkRoomPicks(source: string, picks: readonly Pick[], deps: MultiDeps = {}): Promise<void> {
  if (picks.length === 0) return
  const d: Required<MultiDeps> = {
    run: deps.run ?? runFlowScript,
    keys: deps.keys ?? (async () => [1000]),
    readTopShot: deps.readTopShot ?? readTopShotHoldings,
  }
  const groups = new Map<Pick["collection"], string[]>()
  for (const p of picks) groups.set(p.collection, [...(groups.get(p.collection) ?? []), p.id])
  for (const [collection, ids] of groups) {
    let holdings: Record<string, Holding>
    try {
      holdings = await readCollectionHoldings(collection, source, ids, d)
    } catch (e) {
      throw chainUnavailable(e)
    }
    const label = swapCollection(collection)?.short ?? collection
    const missing = ids.filter((id) => !holdings[id]?.held)
    if (missing.length) throw new TradeRoomError(`${source} doesn't hold ${label} ${missing.join(", ")} right now.`, 409, "not_held")
    const locked = ids.filter((id) => holdings[id]?.locked !== false)
    if (locked.length) throw new TradeRoomError(`Locked on ${label} (unlock first): ${locked.join(", ")}.`, 409, "locked")
  }
}

/**
 * The other side's account must be able to RECEIVE each collection these picks come from — a
 * Dapper account that never held All Day has no All Day collection, and nothing in the swap can
 * create one (found by the 2026-11-02 mainnet probe). Checked when the picks are SAVED, so the
 * collector reads it then, not after both sides accepted and the simulation failed. A failed
 * read is the 503 above, never "can't receive". The planner checks it again before signing.
 */
export async function checkReceivable(otherSource: string, picks: readonly Pick[], deps: MultiDeps = {}): Promise<void> {
  const wanted = SWAP_COLLECTIONS.filter((c) => picks.some((p) => p.collection === c.slug))
  if (wanted.length === 0) return
  let receive: boolean[]
  try {
    receive = await readCanReceive(otherSource, deps.run ?? runFlowScript)
  } catch (e) {
    throw chainUnavailable(e)
  }
  const cannot = wanted.filter((c) => !receive[SWAP_COLLECTIONS.indexOf(c)])
  if (cannot.length) {
    throw new TradeRoomError(
      `${otherSource} has no ${cannot.map((c) => c.label).join(" or ")} collection, so it can't receive ${cannot.length === 1 ? "that" : "those"} Moments. Pick from another collection, or use an account that holds ${cannot[0].label}.`,
      409,
      "cannot_receive",
    )
  }
}

/** True when every item in the room is Top Shot: the room signs the ORIGINAL proven swap text. */
export function isTopShotOnly(loaded: LoadedRoom): boolean {
  return loaded.items.every((i) => (i.collection ?? "nba_top_shot") === "nba_top_shot")
}

function multiInput(loaded: LoadedRoom, side: SideRow): MultiSideInput {
  return {
    signer: side.signer as string,
    source: side.source as string,
    picks: loaded.items
      .filter((i) => i.side === side.side)
      .map((i) => {
        const c = swapCollectionByDbSlug(i.collection ?? "nba_top_shot")
        if (!c) throw new TradeRoomError("That collection can't be traded here.", 400, "bad_collection")
        return { collection: c.slug, id: i.moment_id }
      }),
  }
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
export async function planRoom(loaded: LoadedRoom, initiator: Side, deps: PlanDeps = {}, multiDeps: MultiDeps = {}): Promise<SwapPlan | MultiPlan> {
  if (loaded.room.status !== "accepted" && loaded.room.status !== "signing") {
    throw new TradeRoomError("Both sides must accept the trade before it can be simulated.", 409, "not_accepted")
  }
  const a = loaded.sides.find((s) => s.side === initiator)
  const b = loaded.sides.find((s) => s.side === otherSide(initiator))
  if (!a?.signer || !a.source || !b?.signer || !b.source) throw new TradeRoomError("Both sides need a proven Flow Wallet.", 409, "no_wallet")
  try {
    // an all-Top-Shot room signs the original swap (sealed twice on mainnet 2026-10-31);
    // anything with All Day / Golazos / UFC signs the multi-collection swap
    if (!isTopShotOnly(loaded)) return await planMultiSwap(multiInput(loaded, a), multiInput(loaded, b), multiDeps)
    return await planSwap(sideInput(loaded, a), sideInput(loaded, b), deps)
  } catch (e) {
    if (e instanceof SwapTestError) throw new TradeRoomError(e.message, e.status, e.code)
    throw e
  }
}

/** After a seal: where each moment is now, read from the chain (a failed read throws). */
export async function verifyRoom(loaded: LoadedRoom, deps: { read?: PlanDeps["read"] } = {}, multiDeps: MultiDeps = {}): Promise<Array<LandedMoment | LandedPick>> {
  const a = loaded.sides.find((s) => s.side === "a")
  const b = loaded.sides.find((s) => s.side === "b")
  if (!a?.signer || !a.source || !b?.signer || !b.source) throw new TradeRoomError("Both sides need a proven Flow Wallet.", 409, "no_wallet")
  try {
    if (!isTopShotOnly(loaded)) return await verifyMultiSwap(multiInput(loaded, a), multiInput(loaded, b), multiDeps)
    return await verifySwap({ a: sideInput(loaded, a), b: sideInput(loaded, b) }, deps)
  } catch (e) {
    if (e instanceof SwapTestError) throw new TradeRoomError(e.message, e.status, e.code)
    throw e
  }
}
