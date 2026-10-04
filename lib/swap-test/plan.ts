// lib/swap-test/plan.ts
//
// Plans the admin-only two-signer swap test (lib/swap-test/swap-cadence.ts).
// Server-only; RPC signs nothing. A plan is returned only after the WHOLE swap
// was simulated against live mainnet state, so the two wallets are only ever
// asked to sign a transaction that just worked. Any chain read that fails is an
// error, never a "not held" or an empty side.

import { PROVIDER_CONTROLLERS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import { addr, arrayOf, runFlowScript, u64, type CdcValue } from "@/lib/giveaways/flow-script"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { MAX_SWAP_SIDE, SWAP_SIMULATION_SCRIPT } from "@/lib/swap-test/swap-cadence"

export class SwapTestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "SwapTestError"
  }
}

export interface SwapSideInput {
  /** The Flow Wallet that signs for this side. */
  signer: string
  /** Where this side's moments sit: the signer itself, or a Hybrid Custody child it has redeemed. */
  source: string
  /** Top Shot moment ids this side gives (may be empty). */
  ids: string[]
}

export interface SwapSide extends SwapSideInput {
  kind: "own" | "linked"
  /** The child's withdraw capability controller ("0" for an own side, which ignores it). */
  ctl: string
}

export interface SwapPlan {
  a: SwapSide
  b: SwapSide
}

export interface PlanDeps {
  read?: (address: string, ids: string[]) => Promise<Record<string, Holding>>
  run?: typeof runFlowScript
}

const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/
const MOMENT_ID = /^[0-9]{1,20}$/

function cleanSide(raw: unknown, name: "A" | "B"): SwapSideInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const signer = typeof r.signer === "string" ? r.signer.trim().toLowerCase() : ""
  const source = typeof r.source === "string" ? r.source.trim().toLowerCase() : ""
  if (!FLOW_ADDRESS.test(signer)) throw new SwapTestError(`Side ${name}: the signer is not a Flow 0x address.`, 400, "bad_signer")
  if (!FLOW_ADDRESS.test(source)) throw new SwapTestError(`Side ${name}: the source is not a Flow 0x address.`, 400, "bad_source")
  const rawIds = Array.isArray(r.ids) ? r.ids : []
  const ids = rawIds.map((x) => String(x).trim()).filter((x) => x !== "")
  if (ids.some((id) => !MOMENT_ID.test(id))) throw new SwapTestError(`Side ${name}: a moment id is not a number.`, 400, "bad_id")
  if (new Set(ids).size !== ids.length) throw new SwapTestError(`Side ${name} lists a moment twice.`, 400, "duplicate_id")
  if (ids.length > MAX_SWAP_SIDE) throw new SwapTestError(`Side ${name}: at most ${MAX_SWAP_SIDE} moments per side.`, 400, "too_many")
  return { signer, source, ids }
}

/** Validates the two sides; throws a 400 SwapTestError on anything malformed. */
export function validateSwapInput(rawA: unknown, rawB: unknown): { a: SwapSideInput; b: SwapSideInput } {
  const a = cleanSide(rawA, "A")
  const b = cleanSide(rawB, "B")
  if (a.signer === b.signer) throw new SwapTestError("The two sides need two different signing wallets.", 400, "same_signer")
  if (a.source === b.source) throw new SwapTestError("Both sides draw from the same account.", 400, "same_source")
  if (a.ids.length + b.ids.length === 0) throw new SwapTestError("Neither side gives a moment.", 400, "empty")
  return { a, b }
}

function uintArray(v: CdcValue, what: string): string[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new SwapTestError(`The ${what} returned an unexpected shape.`, 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => String(x.value))
}

function boolArray(v: CdcValue): boolean[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new SwapTestError("The swap simulation returned an unexpected shape.", 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => x.value === true)
}

async function resolveSide(side: SwapSideInput, name: "A" | "B", deps: Required<PlanDeps>): Promise<SwapSide> {
  if (side.ids.length) {
    let holdings: Record<string, Holding>
    try {
      holdings = await deps.read(side.source, side.ids)
    } catch (e) {
      throw new SwapTestError(`Side ${name}: couldn't read the chain (${e instanceof Error ? e.message : String(e)}). Try again.`, 502, "chain_read_failed")
    }
    const missing = side.ids.filter((id) => !holdings[id]?.held)
    if (missing.length) throw new SwapTestError(`Side ${name}: ${side.source} does not hold ${missing.join(", ")}.`, 409, "not_held")
    const locked = side.ids.filter((id) => holdings[id]?.locked !== false)
    if (locked.length) throw new SwapTestError(`Side ${name}: locked on chain (unlock in Top Shot first): ${locked.join(", ")}.`, 409, "locked")
  }
  if (side.source === side.signer) return { ...side, kind: "own", ctl: "0" }
  const controllers = uintArray(await deps.run(PROVIDER_CONTROLLERS_SCRIPT, [addr(side.signer), addr(side.source)]), "controller lookup")
  if (controllers.length === 0) {
    throw new SwapTestError(`Side ${name}: ${side.signer} cannot withdraw from ${side.source} (not a redeemed parent, or Dapper's filter blocks it).`, 409, "not_parent")
  }
  return { ...side, kind: "linked", ctl: controllers[0] }
}

/** Positional script arguments shared by the simulation (after the two signers) and the transaction. */
export function swapArgs(plan: SwapPlan) {
  return [
    addr(plan.a.source),
    u64(plan.a.ctl),
    arrayOf(plan.a.ids.map(u64)),
    addr(plan.b.source),
    u64(plan.b.ctl),
    arrayOf(plan.b.ids.map(u64)),
  ]
}

export async function planSwap(rawA: unknown, rawB: unknown, deps: PlanDeps = {}): Promise<SwapPlan> {
  const d: Required<PlanDeps> = { read: deps.read ?? readTopShotHoldings, run: deps.run ?? runFlowScript }
  const input = validateSwapInput(rawA, rawB)
  const plan: SwapPlan = { a: await resolveSide(input.a, "A", d), b: await resolveSide(input.b, "B", d) }
  let sim: CdcValue
  try {
    sim = await d.run(SWAP_SIMULATION_SCRIPT, [addr(plan.a.signer), addr(plan.b.signer), ...swapArgs(plan)])
  } catch (e) {
    throw new SwapTestError(`The swap simulation failed: ${e instanceof Error ? e.message : String(e)}`, 409, "simulation_failed")
  }
  const landed = boolArray(sim)
  const expected = plan.a.ids.length + plan.b.ids.length
  if (landed.length !== expected || landed.some((x) => !x)) {
    throw new SwapTestError("The simulated swap did not land every moment; not asking either wallet to sign it.", 409, "simulation_failed")
  }
  return plan
}
