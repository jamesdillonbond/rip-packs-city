// lib/trade-room/multi-plan.ts
//
// Plans a trade room swap that holds moments from MORE THAN Top Shot (2026-11-02): NBA Top
// Shot, NFL All Day, LaLiga Golazos and UFC Strike in one transaction
// (lib/trade-room/multi-swap-cadence.ts).
// Server-only; RPC signs nothing. Same contract as the Top Shot planner it extends
// (lib/swap-test/plan.ts): a plan is returned only after the WHOLE swap was simulated against
// live mainnet state, so the two wallets are only ever asked to sign a transaction that just
// worked. Any chain read that fails is an error — never "not held", never an empty side.
//
// What this adds over the Top Shot planner, each checked BEFORE the simulation so the user
// reads which moment / which account / which collection, not a Cadence panic:
//   · held (and, for Top Shot, unlocked) per collection — All Day, Golazos and UFC have no locking;
//   · the RECEIVING account has that collection (a Dapper account that never held All Day has
//     no All Day collection, and nothing in this transaction can create one in it);
//   · a linked (Dapper) source exposes a withdraw capability FOR THAT COLLECTION to the
//     signing wallet (Dapper's filter decides per collection).

import { addr, arrayOf, runFlowScript, u64, type CdcArg, type CdcValue } from "@/lib/giveaways/flow-script"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { canSignAlone, readActiveKeyWeights, SwapTestError } from "@/lib/swap-test/plan"
import {
  CAN_RECEIVE_SCRIPT,
  MAX_MULTI_SIDE,
  MULTI_SWAP_SIMULATION_SCRIPT,
  SWAP_COLLECTIONS,
  controllersScript,
  heldScript,
  idsScript,
  swapCollection,
  type SwapSlug,
} from "@/lib/trade-room/multi-swap-cadence"

export interface Pick {
  collection: SwapSlug
  id: string
}

export interface MultiSideInput {
  signer: string
  source: string
  picks: Pick[]
}

export interface MultiSide {
  signer: string
  source: string
  kind: "own" | "linked"
  /** One controller id per SWAP_COLLECTIONS entry ("0" where the side gives none there, or is "own"). */
  ctls: string[]
  /** One id list per SWAP_COLLECTIONS entry, in that order. */
  ids: string[][]
}

export interface MultiPlan {
  kind: "multi"
  a: MultiSide
  b: MultiSide
}

export interface MultiDeps {
  run?: typeof runFlowScript
  keys?: (address: string) => Promise<number[]>
  /** Top Shot held + locked read (defaults to the chain). */
  readTopShot?: (address: string, ids: string[]) => Promise<Record<string, Holding>>
}

const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/
const MOMENT_ID = /^[0-9]{1,20}$/

export function pickKey(p: Pick): string {
  return `${p.collection}:${p.id}`
}

function cleanSide(raw: MultiSideInput, name: "A" | "B"): MultiSideInput {
  const signer = String(raw?.signer ?? "").trim().toLowerCase()
  const source = String(raw?.source ?? "").trim().toLowerCase()
  if (!FLOW_ADDRESS.test(signer)) throw new SwapTestError(`Side ${name}: the signer is not a Flow 0x address.`, 400, "bad_signer")
  if (!FLOW_ADDRESS.test(source)) throw new SwapTestError(`Side ${name}: the source is not a Flow 0x address.`, 400, "bad_source")
  const picks = Array.isArray(raw?.picks) ? raw.picks : []
  for (const p of picks) {
    if (!swapCollection(p?.collection)) throw new SwapTestError(`Side ${name}: ${String(p?.collection)} can't be traded here.`, 400, "bad_collection")
    if (!MOMENT_ID.test(String(p?.id))) throw new SwapTestError(`Side ${name}: a moment id is not a number.`, 400, "bad_id")
  }
  if (new Set(picks.map(pickKey)).size !== picks.length) throw new SwapTestError(`Side ${name} lists a moment twice.`, 400, "duplicate_id")
  if (picks.length > MAX_MULTI_SIDE) throw new SwapTestError(`Side ${name}: at most ${MAX_MULTI_SIDE} moments per side.`, 400, "too_many")
  return { signer, source, picks: picks.map((p) => ({ collection: p.collection, id: String(p.id) })) }
}

export function validateMultiInput(rawA: MultiSideInput, rawB: MultiSideInput): { a: MultiSideInput; b: MultiSideInput } {
  const a = cleanSide(rawA, "A")
  const b = cleanSide(rawB, "B")
  if (a.signer === b.signer) throw new SwapTestError("The two sides need two different signing wallets.", 400, "same_signer")
  if (a.source === b.source) throw new SwapTestError("Both sides draw from the same account.", 400, "same_source")
  if (a.picks.length + b.picks.length === 0) throw new SwapTestError("Neither side gives a moment.", 400, "empty")
  return { a, b }
}

function boolArray(v: CdcValue, what: string): boolean[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new SwapTestError(`The ${what} returned an unexpected shape.`, 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => x.value === true)
}

function stringArray(v: CdcValue, what: string): string[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new SwapTestError(`The ${what} returned an unexpected shape.`, 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => String(x.value))
}

function readFailed(name: string, e: unknown): SwapTestError {
  return new SwapTestError(`${name}: couldn't read the chain (${e instanceof Error ? e.message : String(e)}). Try again.`, 502, "chain_read_failed")
}

/**
 * Held (and for Top Shot, locked) state of `ids` of one collection at `address`. Throws on a
 * failed read. Ids not held are present with held=false.
 */
export async function readCollectionHoldings(
  collection: SwapSlug,
  address: string,
  ids: string[],
  deps: Required<MultiDeps>,
): Promise<Record<string, Holding>> {
  if (collection === "nba-top-shot") return deps.readTopShot(address, ids)
  const out: Record<string, Holding> = {}
  for (const id of ids) out[id] = { held: false, locked: null }
  const held = stringArray(await deps.run(heldScript(collection), [addr(address), arrayOf(ids.map(u64))]), "holdings read")
  // All Day, Golazos and UFC have no locking contract: a held moment is unlocked
  for (const id of held) if (id in out) out[id] = { held: true, locked: false }
  return out
}

/** A held/locked reader for one collection with the production chain deps (the picker's live read). */
export function holdingsReader(collection: SwapSlug): (address: string, ids: string[]) => Promise<Record<string, Holding>> {
  return (address, ids) =>
    readCollectionHoldings(collection, address, ids, { run: runFlowScript, keys: async () => [], readTopShot: readTopShotHoldings })
}

/** Every id an account holds of one collection, or null when it has no such collection. Throws on a failed read. */
export function idsReader(collection: Exclude<SwapSlug, "nba-top-shot">, run: typeof runFlowScript = runFlowScript): (address: string) => Promise<string[] | null> {
  return async (address) => {
    const v = await run(idsScript(collection), [addr(address)])
    if (v?.type !== "Optional") throw new SwapTestError("The holdings read returned an unexpected shape.", 502, "flow_shape")
    if (v.value == null) return null
    return stringArray(v.value as CdcValue, "holdings read")
  }
}

function byCollection(picks: Pick[]): string[][] {
  return SWAP_COLLECTIONS.map((c) => picks.filter((p) => p.collection === c.slug).map((p) => p.id))
}

/** Which collections `address` can receive, in SWAP_COLLECTIONS order. */
export async function readCanReceive(address: string, run: typeof runFlowScript): Promise<boolean[]> {
  const out = boolArray(await run(CAN_RECEIVE_SCRIPT, [addr(address)]), "receiver check")
  if (out.length !== SWAP_COLLECTIONS.length) throw new SwapTestError("The receiver check returned an unexpected shape.", 502, "flow_shape")
  return out
}

async function resolveSide(side: MultiSideInput, other: MultiSideInput, name: "A" | "B", d: Required<MultiDeps>): Promise<MultiSide> {
  let weights: number[]
  try {
    weights = await d.keys(side.signer)
  } catch (e) {
    throw new SwapTestError(`Side ${name}: couldn't read ${side.signer}'s keys (${e instanceof Error ? e.message : String(e)}). Try again.`, 502, "chain_read_failed")
  }
  if (!canSignAlone(weights)) {
    throw new SwapTestError(
      `Side ${name}: ${side.signer} has no full-weight key (active weights: ${weights.join(", ") || "none"}), so it can't sign on its own. Use a Flow Wallet account.`,
      409,
      "cannot_sign_alone",
    )
  }
  const ids = byCollection(side.picks)
  // held (+ unlocked) per collection
  for (let i = 0; i < SWAP_COLLECTIONS.length; i++) {
    if (!ids[i].length) continue
    const c = SWAP_COLLECTIONS[i]
    let holdings: Record<string, Holding>
    try {
      holdings = await readCollectionHoldings(c.slug, side.source, ids[i], d)
    } catch (e) {
      if (e instanceof SwapTestError) throw e
      throw readFailed(`Side ${name}`, e)
    }
    const missing = ids[i].filter((id) => !holdings[id]?.held)
    if (missing.length) throw new SwapTestError(`Side ${name}: ${side.source} does not hold ${c.label} ${missing.join(", ")}.`, 409, "not_held")
    const locked = ids[i].filter((id) => holdings[id]?.locked !== false)
    if (locked.length) throw new SwapTestError(`Side ${name}: locked on chain (unlock in ${c.label} first): ${locked.join(", ")}.`, 409, "locked")
  }
  // the other side's account must be able to receive each collection this side gives
  if (side.picks.length) {
    let receive: boolean[]
    try {
      receive = await readCanReceive(other.source, d.run)
    } catch (e) {
      if (e instanceof SwapTestError) throw e
      throw readFailed(`Side ${name}`, e)
    }
    const cannot = SWAP_COLLECTIONS.filter((c, i) => ids[i].length > 0 && !receive[i])
    if (cannot.length) {
      throw new SwapTestError(
        `${other.source} has no ${cannot.map((c) => c.label).join(" or ")} collection, so it can't receive ${cannot.length === 1 ? "that Moment" : "those Moments"}. Its owner can set one up by collecting any ${cannot[0].label} Moment on that account first.`,
        409,
        "cannot_receive",
      )
    }
  }
  const ctls = SWAP_COLLECTIONS.map(() => "0")
  if (side.source === side.signer) return { signer: side.signer, source: side.source, kind: "own", ctls, ids }
  for (let i = 0; i < SWAP_COLLECTIONS.length; i++) {
    if (!ids[i].length) continue
    const c = SWAP_COLLECTIONS[i]
    let found: string[]
    try {
      found = stringArray(await d.run(controllersScript(c.storage), [addr(side.signer), addr(side.source)]), "controller lookup")
    } catch (e) {
      if (e instanceof SwapTestError) throw e
      throw readFailed(`Side ${name}`, e)
    }
    if (found.length === 0) {
      throw new SwapTestError(`Side ${name}: ${side.signer} cannot withdraw ${c.label} from ${side.source} (not a linked parent, or Dapper's filter blocks it).`, 409, "not_parent")
    }
    ctls[i] = found[0]
  }
  return { signer: side.signer, source: side.source, kind: "linked", ctls, ids }
}

/** Positional arguments shared by the simulation (after the two signers) and the transaction. */
export function multiSwapArgs(plan: MultiPlan): CdcArg[] {
  const side = (s: MultiSide) => [addr(s.source), arrayOf(s.ctls.map(u64)), arrayOf(s.ids.map((l) => arrayOf(l.map(u64))))]
  return [...side(plan.a), ...side(plan.b)]
}

export async function planMultiSwap(rawA: MultiSideInput, rawB: MultiSideInput, deps: MultiDeps = {}): Promise<MultiPlan> {
  const d: Required<MultiDeps> = {
    run: deps.run ?? runFlowScript,
    keys: deps.keys ?? ((a) => readActiveKeyWeights(a)),
    readTopShot: deps.readTopShot ?? readTopShotHoldings,
  }
  const { a, b } = validateMultiInput(rawA, rawB)
  const plan: MultiPlan = { kind: "multi", a: await resolveSide(a, b, "A", d), b: await resolveSide(b, a, "B", d) }
  let sim: CdcValue
  try {
    sim = await d.run(MULTI_SWAP_SIMULATION_SCRIPT, [addr(plan.a.signer), addr(plan.b.signer), ...multiSwapArgs(plan)])
  } catch (e) {
    throw new SwapTestError(`The swap simulation failed: ${e instanceof Error ? e.message : String(e)}`, 409, "simulation_failed")
  }
  const landed = boolArray(sim, "swap simulation")
  const expected = a.picks.length + b.picks.length
  if (landed.length !== expected || landed.some((x) => !x)) {
    throw new SwapTestError("The simulated swap did not land every moment; not asking either wallet to sign it.", 409, "simulation_failed")
  }
  return plan
}

export interface LandedPick {
  collection: SwapSlug
  id: string
  /** The account the moment should now be in (the OTHER side's source). */
  to: string
  held: boolean
}

/**
 * After the transaction SEALS: read the chain and confirm every moment sits in the other
 * side's account. A failed read throws (502) — never "not landed".
 */
export async function verifyMultiSwap(rawA: MultiSideInput, rawB: MultiSideInput, deps: MultiDeps = {}): Promise<LandedPick[]> {
  const d: Required<MultiDeps> = {
    run: deps.run ?? runFlowScript,
    keys: deps.keys ?? ((x) => readActiveKeyWeights(x)),
    readTopShot: deps.readTopShot ?? readTopShotHoldings,
  }
  const { a, b } = validateMultiInput(rawA, rawB)
  const out: LandedPick[] = []
  for (const leg of [
    { to: b.source, picks: a.picks },
    { to: a.source, picks: b.picks },
  ]) {
    const ids = byCollection(leg.picks)
    for (let i = 0; i < SWAP_COLLECTIONS.length; i++) {
      if (!ids[i].length) continue
      const c = SWAP_COLLECTIONS[i]
      let holdings: Record<string, Holding>
      try {
        holdings = await readCollectionHoldings(c.slug, leg.to, ids[i], d)
      } catch (e) {
        throw new SwapTestError(`Couldn't read ${leg.to} on chain (${e instanceof Error ? e.message : String(e)}). Try Verify again.`, 502, "chain_read_failed")
      }
      for (const id of ids[i]) out.push({ collection: c.slug, id, to: leg.to, held: holdings[id]?.held === true })
    }
  }
  return out
}
