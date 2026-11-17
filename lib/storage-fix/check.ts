// lib/storage-fix/check.ts
//
// Server-only, read-only. The diagnosis behind /admin/storage-fix (Trevor, 2026-11-05):
// is this Flow account stuck on storage (error 1103), can FLOW reach it the Dapper way or
// the plain way, how much would fix it, and — before anyone pays — has it ALREADY been
// topped up (Dapper refills accounts itself: Andrew Laird's 0x9124… was refilled by
// Dapper's own forwarder account on 2026-11-03, two days before he was found asking).
//
// Everything here reads Flow's public REST API (rest-mainnet.onflow.org). Nothing signs.
//
// Three states, never two (CLAUDE.md, honesty): the history search reports `found`, `none`
// (searched a stated window and the capacity never changed) or `unavailable` (a read
// failed / the deadline hit) — a failed search never reads as "never topped up".

import { normalizeFlowAddress } from "@/lib/address"
import { panicMessage } from "@/lib/giveaways/flow-script"
import {
  DAPPER_REFILL_SIMULATION,
  DAPPER_STORAGE_RENT_ADDRESS,
  PLAIN_SEND_SIMULATION,
  PRIVATE_FORWARDER_ADDRESS,
  STORAGE_CAPACITY_SCRIPT,
  STORAGE_STATE_SCRIPT,
} from "@/lib/storage-fix/cadence"

export const FLOW_REST = "https://rest-mainnet.onflow.org/v1"

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 15_000
/** The whole history search must finish inside the route's budget, leaving room for the state read. */
export const HISTORY_DEADLINE_MS = 35_000
/** How far back the search reaches, in blocks (Flow seals ~1.25 blocks/s, so ~32 days). */
export const HISTORY_OFFSETS = [2_000, 10_000, 50_000, 200_000, 800_000, 3_500_000] as const
/** Below this much free storage an account is treated as stuck: Dapper's own refill threshold is 5,000 bytes. */
export const STUCK_HEADROOM_BYTES = 10_000
/** A fix aims to leave this much free room (1 MB). */
export const TARGET_HEADROOM_BYTES = 1_000_000
/** The smallest and largest amount the console offers to send. */
export const MIN_FIX_FLOW = 0.01
export const MAX_FIX_FLOW = 1

export class StorageFixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "StorageFixError"
  }
}

// ── JSON-CDC ─────────────────────────────────────────────────────────────────

interface Cdc {
  type: string
  value: unknown
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** Unwraps an Optional; null for a nil optional. */
function unwrap(v: Cdc | null | undefined): Cdc | null {
  if (!v) return null
  if (v.type === "Optional") return (v.value as Cdc | null) ?? null
  return v
}

function cdcNumber(v: Cdc | null | undefined, what: string): number {
  const u = unwrap(v)
  const n = u ? Number(u.value) : NaN
  if (!Number.isFinite(n)) throw new StorageFixError(`Flow returned no ${what}.`, 502, "flow_decode")
  return n
}

function cdcBool(v: Cdc | null | undefined, what: string): boolean {
  const u = unwrap(v)
  if (!u || typeof u.value !== "boolean") throw new StorageFixError(`Flow returned no ${what}.`, 502, "flow_decode")
  return u.value
}

// ── REST plumbing ────────────────────────────────────────────────────────────

async function getJson(fetchImpl: FetchLike, path: string): Promise<unknown> {
  const res = await fetchImpl(`${FLOW_REST}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new StorageFixError(`Flow REST ${path.split("?")[0]} returned HTTP ${res.status}.`, 502, res.status === 404 ? "flow_not_found" : "flow_http")
  return res.json()
}

type ScriptArg = { type: "Address"; value: string } | { type: "UFix64"; value: string }

/** The Cadence panic carried by a failed script, if any (shared parser: lib/giveaways/flow-script.ts). */
export class ScriptPanic extends StorageFixError {
  constructor(readonly panic: string) {
    super(`Cadence: ${panic}`, 422, "cadence_panic")
  }
}

async function runScript(fetchImpl: FetchLike, script: string, args: string | ScriptArg[], height: number | "sealed"): Promise<Cdc> {
  const list: ScriptArg[] = typeof args === "string" ? [{ type: "Address", value: args }] : args
  const res = await fetchImpl(`${FLOW_REST}/scripts?block_height=${height}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script: b64(script), arguments: list.map((a) => b64(JSON.stringify(a))) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const panic = res.status === 400 ? panicMessage(text) : null
    if (panic) throw new ScriptPanic(panic)
    // a 404 is a height before the current spork's root: the network keeps no state there
    throw new StorageFixError(`Flow script at ${height} returned HTTP ${res.status}.`, 502, res.status === 404 ? "flow_not_found" : "flow_http")
  }
  try {
    return JSON.parse(Buffer.from(text.trim().replace(/^"|"$/g, ""), "base64").toString("utf8")) as Cdc
  } catch {
    throw new StorageFixError("Flow script returned an undecodable body.", 502, "flow_decode")
  }
}

interface BlockHeader {
  height: number
  timestamp: string
}

async function block(fetchImpl: FetchLike, height: number | "sealed"): Promise<BlockHeader> {
  const body = (await getJson(fetchImpl, `/blocks?height=${height}`)) as Array<{ header?: { height?: string; timestamp?: string } }>
  const h = body?.[0]?.header
  const n = Number(h?.height)
  if (!h || !Number.isFinite(n) || typeof h.timestamp !== "string") throw new StorageFixError("Flow returned no block header.", 502, "flow_decode")
  return { height: n, timestamp: h.timestamp }
}

// ── The account's state now ──────────────────────────────────────────────────

export interface StorageState {
  usedBytes: number
  capacityBytes: number
  /** FLOW in the default vault; null when the account exposes no balance capability. */
  balanceFlow: number | null
  /** Has Dapper's private forwarder: a Dapper wallet, reachable only through DapperStorageRent. */
  isDapperWallet: boolean
  /** Has a public FLOW receiver: an ordinary transfer can reach it. */
  hasFlowReceiver: boolean
  /** The network's live storage price. */
  megabytesPerFlow: number
}

export function decodeState(v: Cdc): StorageState {
  const items = Array.isArray(v?.value) ? (v.value as Cdc[]) : []
  if (items.length !== 6) throw new StorageFixError("Flow returned an unexpected storage state.", 502, "flow_decode")
  const bal = unwrap(items[2])
  return {
    usedBytes: cdcNumber(items[0], "storage used"),
    capacityBytes: cdcNumber(items[1], "storage capacity"),
    balanceFlow: bal ? cdcNumber(bal, "balance") : null,
    isDapperWallet: cdcBool(items[3], "forwarder flag"),
    hasFlowReceiver: cdcBool(items[4], "receiver flag"),
    megabytesPerFlow: cdcNumber(items[5], "storage price"),
  }
}

// ── What would fix it ────────────────────────────────────────────────────────

export type FixKind = "dapper_refill" | "plain_send" | "none"

export interface FixPlan {
  /** Free bytes right now (negative when over). */
  headroomBytes: number
  stuck: boolean
  kind: FixKind
  /** UFix64 string (8 decimals) the console proposes; null when nothing can be sent. */
  amount: string | null
  /** Bytes of capacity that amount adds at today's price. */
  addsBytes: number | null
  reason: string
}

/** A UFix64 literal, 8 decimals, from a FLOW amount. */
export function toUFix64(flow: number): string {
  if (!Number.isFinite(flow) || flow <= 0) throw new StorageFixError("Amount must be a positive number of FLOW.", 400, "bad_amount")
  return flow.toFixed(8)
}

/** Parses an operator-typed amount, inside the console's bounds. */
export function parseFixAmount(input: unknown): string {
  const n = Number(String(input ?? "").trim())
  if (!Number.isFinite(n) || n < MIN_FIX_FLOW || n > MAX_FIX_FLOW) {
    throw new StorageFixError(`Amount must be between ${MIN_FIX_FLOW} and ${MAX_FIX_FLOW} FLOW.`, 400, "bad_amount")
  }
  return toUFix64(Math.round(n * 1e8) / 1e8)
}

export function planFix(s: StorageState): FixPlan {
  const headroomBytes = s.capacityBytes - s.usedBytes
  const stuck = headroomBytes < STUCK_HEADROOM_BYTES
  const kind: FixKind = s.isDapperWallet ? "dapper_refill" : s.hasFlowReceiver ? "plain_send" : "none"
  if (kind === "none") {
    return {
      headroomBytes,
      stuck,
      kind,
      amount: null,
      addsBytes: null,
      reason: "This account has neither Dapper's private forwarder nor a public FLOW receiver, so no transaction from here can add FLOW to it. Send the user to their wallet's support.",
    }
  }
  const bytesPerFlow = s.megabytesPerFlow * 1_000_000
  if (!(bytesPerFlow > 0)) throw new StorageFixError("Flow returned no storage price.", 502, "flow_decode")
  const need = Math.max(0, s.usedBytes + TARGET_HEADROOM_BYTES - s.capacityBytes)
  // round UP to 0.01 FLOW, inside the console's bounds
  const flow = Math.min(MAX_FIX_FLOW, Math.max(MIN_FIX_FLOW, Math.ceil((need / bytesPerFlow) * 100) / 100))
  const amount = toUFix64(flow)
  return {
    headroomBytes,
    stuck,
    kind,
    amount,
    addsBytes: Math.round(flow * bytesPerFlow),
    reason:
      kind === "dapper_refill"
        ? "Dapper wallet: it has no public FLOW receiver, so FLOW goes in through DapperStorageRent.fundedRefillV2 (Dapper's private forwarder). The whole amount is spent."
        : "Not a Dapper wallet: an ordinary FLOW transfer to its /public/flowTokenReceiver. The Dapper refill would fail here.",
  }
}

// ── When it was last topped up ───────────────────────────────────────────────

export interface TopUp {
  height: number
  at: string
  capacityBefore: number
  capacityAfter: number
  txId: string | null
  payer: string | null
  authorizers: string[]
  amountFlow: number | null
  /** The FLOW came in through Dapper's private forwarder. */
  viaDapperForwarder: boolean
  /** Signed and paid by Dapper's own forwarder account (Dapper fixed it themselves). */
  byDapper: boolean
}

export type History =
  | { status: "found"; change: TopUp; searchedBackTo: { height: number; at: string | null } }
  | { status: "none"; searchedBackTo: { height: number; at: string | null } }
  | { status: "unavailable"; reason: string }

const sans = (a: string) => a.toLowerCase().replace(/^0x/, "")

interface EventsBody {
  block_height?: string
  events?: Array<{ type?: string; transaction_id?: string; payload?: string }>
}

function eventFields(payloadB64: string | undefined): Record<string, unknown> {
  try {
    const p = JSON.parse(Buffer.from(String(payloadB64 ?? ""), "base64").toString("utf8")) as {
      value?: { fields?: Array<{ name: string; value: Cdc }> }
    }
    const out: Record<string, unknown> = {}
    for (const f of p?.value?.fields ?? []) {
      const u = unwrap(f.value)
      out[f.name] = u && typeof u.value === "object" && u.value && "value" in (u.value as object) ? (u.value as Cdc).value : u?.value ?? null
    }
    return out
  } catch {
    return {}
  }
}

/** The deposit that changed the capacity at `height`: its transaction, who signed, how it came in. */
async function describeChange(fetchImpl: FetchLike, address: string, height: number): Promise<Omit<TopUp, "height" | "at" | "capacityBefore" | "capacityAfter">> {
  const type = "A.1654653399040a61.FlowToken.TokensDeposited"
  const body = (await getJson(fetchImpl, `/events?type=${type}&start_height=${height}&end_height=${height}`)) as EventsBody[]
  const hit = (body ?? []).flatMap((b) => b.events ?? []).find((e) => sans(String(eventFields(e.payload).to ?? "")) === sans(address))
  if (!hit?.transaction_id) {
    return { txId: null, payer: null, authorizers: [], amountFlow: null, viaDapperForwarder: false, byDapper: false }
  }
  const txId = hit.transaction_id
  const amount = Number(eventFields(hit.payload).amount)
  const tx = (await getJson(fetchImpl, `/transactions/${txId}`)) as { payer?: string; authorizers?: string[] }
  const result = (await getJson(fetchImpl, `/transaction_results/${txId}`)) as { events?: Array<{ type?: string }> }
  const payer = tx?.payer ? `0x${sans(tx.payer)}` : null
  return {
    txId,
    payer,
    authorizers: (tx?.authorizers ?? []).map((a) => `0x${sans(a)}`),
    amountFlow: Number.isFinite(amount) ? amount : null,
    viaDapperForwarder: (result?.events ?? []).some((e) => String(e.type).endsWith("PrivateReceiverForwarder.PrivateDeposit")),
    byDapper: payer === PRIVATE_FORWARDER_ADDRESS,
  }
}

/**
 * The most recent block at which the account's storage capacity changed, inside the last
 * ~HISTORY_OFFSETS blocks. Samples backwards, then binary-searches the bracket.
 */
export async function findLastCapacityChange(
  fetchImpl: FetchLike,
  address: string,
  current: { height: number; capacity: number },
  now: () => number = Date.now,
): Promise<History> {
  const deadline = now() + HISTORY_DEADLINE_MS
  const capAt = async (h: number) => {
    if (now() > deadline) throw new StorageFixError("history search ran out of time", 504, "deadline")
    return cdcNumber(await runScript(fetchImpl, STORAGE_CAPACITY_SCRIPT, address, h), "capacity")
  }
  try {
    let newer = current.height // capacity == current here
    let older: number | null = null
    let olderCap = current.capacity
    let reached = current.height
    for (const off of HISTORY_OFFSETS) {
      const h = current.height - off
      if (h <= 0) break
      let cap: number
      try {
        cap = await capAt(h)
      } catch (e) {
        // older than the current spork (the API answers 404 there): the window ends here.
        // Any OTHER failure is a failed read, never "no change found".
        if (e instanceof StorageFixError && e.code === "flow_not_found") break
        throw e
      }
      reached = h
      if (cap !== current.capacity) {
        older = h
        olderCap = cap
        break
      }
      newer = h
    }
    const backTo = async (height: number) => ({ height, at: (await block(fetchImpl, height).catch(() => null))?.timestamp ?? null })
    if (older === null) return { status: "none", searchedBackTo: await backTo(reached) }
    // invariant: capacity(older) != current, capacity(newer) == current
    let lo = older
    let hi = newer
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      const cap = await capAt(mid)
      if (cap === current.capacity) hi = mid
      else {
        lo = mid
        olderCap = cap
      }
    }
    const header = await block(fetchImpl, hi)
    const detail = await describeChange(fetchImpl, address, hi)
    return {
      status: "found",
      change: { height: hi, at: header.timestamp, capacityBefore: olderCap, capacityAfter: current.capacity, ...detail },
      searchedBackTo: await backTo(reached),
    }
  } catch (e) {
    return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── The whole check ──────────────────────────────────────────────────────────

// ── The fix, simulated before anyone signs ───────────────────────────────────

export type Simulation =
  | { ok: true; kind: Exclude<FixKind, "none">; signer: string; amount: string; capacityBefore: number; capacityAfter: number }
  | { ok: false; kind: FixKind; signer: string; amount: string; reason: string }

/**
 * Runs the fix's own statements (lib/storage-fix/cadence.ts *_SIMULATION) as a read-only
 * script at `height`, with the operator's address as signer. A Cadence panic is a REFUSAL
 * (`ok:false`, with the panic); any other failure throws — it is a failed read, not a verdict.
 */
export async function simulateFix(
  fetchImpl: FetchLike,
  kind: FixKind,
  signerInput: unknown,
  receiver: string,
  amountInput: unknown,
  height: number,
): Promise<Simulation> {
  const signer = normalizeFlowAddress(signerInput)
  if (!signer) throw new StorageFixError("The signing wallet is not a Flow address.", 400, "bad_signer")
  const amount = parseFixAmount(amountInput)
  if (kind === "none") return { ok: false, kind, signer, amount, reason: "No transaction from here can add FLOW to this account." }
  const script = kind === "dapper_refill" ? DAPPER_REFILL_SIMULATION : PLAIN_SEND_SIMULATION
  try {
    const out = await runScript(
      fetchImpl,
      script,
      [
        { type: "Address", value: signer },
        { type: "Address", value: receiver },
        { type: "UFix64", value: amount },
      ],
      height,
    )
    const items = Array.isArray(out?.value) ? (out.value as Cdc[]) : []
    if (items.length !== 2) throw new StorageFixError("Flow returned an unexpected simulation result.", 502, "flow_decode")
    return { ok: true, kind, signer, amount, capacityBefore: cdcNumber(items[0], "capacity"), capacityAfter: cdcNumber(items[1], "capacity") }
  } catch (e) {
    if (e instanceof ScriptPanic) return { ok: false, kind, signer, amount, reason: e.panic }
    throw e
  }
}

// ── The whole check ──────────────────────────────────────────────────────────

export interface StorageCheck {
  address: string
  checkedAt: { height: number; at: string }
  state: StorageState
  plan: FixPlan
  history: History
  /** Present only when asked for (`simulate.from`): the fix run as a script at the same block. */
  simulation?: Simulation
  contracts: { dapperStorageRent: string; privateForwarder: string }
}

export async function checkStorage(
  input: unknown,
  fetchImpl: FetchLike = fetch,
  opts: { simulate?: { from: unknown; amount: unknown } } = {},
): Promise<StorageCheck> {
  const address = normalizeFlowAddress(input)
  if (!address) throw new StorageFixError("Enter a Flow address: 0x followed by 16 hex characters.", 400, "bad_address")
  // pin every read to ONE sealed block, so state, history and simulation describe the same moment
  const sealed = await block(fetchImpl, "sealed")
  const state = decodeState(await runScript(fetchImpl, STORAGE_STATE_SCRIPT, address, sealed.height))
  const plan = planFix(state)
  const simulation = opts.simulate
    ? await simulateFix(fetchImpl, plan.kind, opts.simulate.from, address, opts.simulate.amount, sealed.height)
    : undefined
  const history = await findLastCapacityChange(fetchImpl, address, { height: sealed.height, capacity: state.capacityBytes })
  return {
    address,
    checkedAt: { height: sealed.height, at: sealed.timestamp },
    state,
    plan,
    history,
    ...(simulation ? { simulation } : {}),
    contracts: { dapperStorageRent: DAPPER_STORAGE_RENT_ADDRESS, privateForwarder: PRIVATE_FORWARDER_ADDRESS },
  }
}
