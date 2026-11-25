// lib/trade-room/seal-tx.ts
//
// 2026-11-13 (review): `sealed` checked that every Moment LANDED but stored whatever 64-hex
// `tx_id` the caller sent, and the room page links that id on flowscan as "the transaction
// that sealed this trade". Either party could record an unrelated transaction. The id is now
// read from the chain before it is stored: it must exist, have executed without error, and be
// authorized by BOTH of the room's wallets (the trade is a two-authorizer transaction).
//
// A read that fails is a 503 + retryable, never "not this trade".
//
// 2026-11-24 (security review, trading.md Open 6): authorized-by-both was not enough. Any OTHER
// transaction the same two wallets signed together (an earlier trade between them) passed, so a
// stale room could be sealed against the wrong flowscan link. The transaction's SCRIPT must now be
// the one text this room signs, and its ARGUMENTS must decode to this room: the two sides' sources
// and the set of Moments each side gives, with the first authorizer the signer of the side the
// arguments name first (the Cadence binds sourceA/idsA to authorizer `a`). Checked against the two
// real 10-31 swaps (3e1c0976…, c48f280a…): script byte-identical to SWAP_CADENCE (md5 c9c72dc5…).

import { TradeRoomError, type LoadedRoom, type Side } from "@/lib/trade-room/store"
import { expectedCadence, expectedLabels } from "@/lib/trade-room/relay-guard"
import { describeRoomSignable } from "@/lib/trade-room/signable"

export const FLOW_REST = process.env.FLOW_ACCESS_NODE || "https://rest-mainnet.onflow.org"

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const sans0x = (a: string) => a.trim().toLowerCase().replace(/^0x/, "")

/** Statuses at which a transaction's effects are final on chain. */
const FINAL = new Set(["sealed", "executed"])

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  return sa.size === a.length && b.every((x) => sa.has(x))
}

/** base64 JSON-Cadence → value; null when it doesn't decode. */
function decodeArg(a: unknown): unknown {
  if (typeof a !== "string") return null
  try {
    return JSON.parse(Buffer.from(a, "base64").toString("utf8"))
  } catch {
    return null
  }
}

/**
 * Null when the transaction body (Flow REST `/v1/transactions/<id>`) is this room's trade,
 * otherwise the reason it is not. Pure.
 */
export function txMismatch(txBody: { script?: unknown; arguments?: unknown; authorizers?: unknown }, loaded: LoadedRoom): string | null {
  let script: string
  try {
    script = typeof txBody.script === "string" ? Buffer.from(txBody.script, "base64").toString("utf8") : ""
  } catch {
    script = ""
  }
  let want: string
  try {
    want = expectedCadence(loaded)
  } catch {
    return "this room's items can't be traded"
  }
  if (script !== want) return "it runs a different transaction"
  const args = (Array.isArray(txBody.arguments) ? txBody.arguments : []).map(decodeArg)
  const d = describeRoomSignable({ cadence: script, args })
  if (!d.ok) return "its arguments don't decode as a trade"
  const sideOf = (source: string): Side | null => loaded.sides.find((x) => !!x.source && sans0x(x.source) === sans0x(source))?.side ?? null
  const sideA = sideOf(d.sourceA)
  const sideB = sideOf(d.sourceB)
  if (!sideA || !sideB || sideA === sideB) return "it moves Moments between other wallets"
  let labelsA: string[]
  let labelsB: string[]
  try {
    labelsA = expectedLabels(loaded, sideA)
    labelsB = expectedLabels(loaded, sideB)
  } catch {
    return "this room's items can't be traded"
  }
  if (!sameSet(d.idsA, labelsA) || !sameSet(d.idsB, labelsB)) return "it moves different Moments"
  const first = (Array.isArray(txBody.authorizers) ? txBody.authorizers : [])[0]
  const signerA = loaded.sides.find((x) => x.side === sideA)?.signer
  if (!signerA || first == null || sans0x(String(first)) !== sans0x(signerA)) return "its signers are in the wrong roles"
  return null
}

/**
 * Throws unless `txId` is a final, error-free transaction authorized by both of the room's
 * wallets that runs THIS room's trade (`txMismatch`). 409 `bad_tx` when the chain says it is
 * not this trade; 503 when it can't be read.
 */
export async function assertSealTx(txId: string, loaded: LoadedRoom, fetchFn: FetchFn = fetch): Promise<void> {
  const signers = loaded.sides.map((s) => s.signer).filter((x): x is string => !!x)
  if (!/^[0-9a-f]{64}$/.test(txId)) throw new TradeRoomError("Not a Flow transaction id.", 400, "bad_tx")
  const unavailable = (why: string) =>
    new TradeRoomError(`We couldn't read that transaction from the Flow blockchain (${why}). Try again in a minute.`, 503, "upstream_unavailable")
  const notOurs = (why: string) =>
    new TradeRoomError(`That transaction isn't this trade (${why}). Nothing was recorded.`, 409, "bad_tx")

  let tx: Response
  let result: Response
  try {
    ;[tx, result] = await Promise.all([
      fetchFn(`${FLOW_REST}/v1/transactions/${txId}`, { signal: AbortSignal.timeout(8000) }),
      fetchFn(`${FLOW_REST}/v1/transaction_results/${txId}`, { signal: AbortSignal.timeout(8000) }),
    ])
  } catch (e) {
    throw unavailable(e instanceof Error ? e.message : String(e))
  }
  // 404 (and 400, which the access node returns for an unknown id) is an ANSWER: no such transaction.
  if (tx.status === 404 || tx.status === 400) throw notOurs("no such transaction on Flow mainnet")
  if (!tx.ok) throw unavailable(`access node ${tx.status}`)
  if (result.status === 404 || result.status === 400) throw notOurs("no such transaction on Flow mainnet")
  if (!result.ok) throw unavailable(`access node ${result.status}`)

  let txBody: { authorizers?: unknown; script?: unknown; arguments?: unknown }
  let resultBody: { status?: unknown; status_code?: unknown; error_message?: unknown }
  try {
    txBody = (await tx.json()) as typeof txBody
    resultBody = (await result.json()) as typeof resultBody
  } catch (e) {
    throw unavailable(e instanceof Error ? e.message : String(e))
  }

  const status = String(resultBody.status ?? "").toLowerCase()
  if (!FINAL.has(status)) throw unavailable(`transaction is ${status || "not final"} yet`)
  const code = Number(resultBody.status_code ?? 0)
  const err = typeof resultBody.error_message === "string" ? resultBody.error_message.trim() : ""
  if (code !== 0 || err) throw notOurs("it failed on chain")

  const auth = new Set((Array.isArray(txBody.authorizers) ? txBody.authorizers : []).map((a) => sans0x(String(a))))
  const missing = signers.map(sans0x).filter((s) => !auth.has(s))
  if (signers.length < 2 || missing.length) throw notOurs("it wasn't signed by both of this room's wallets")
  const why = txMismatch(txBody, loaded)
  if (why) throw notOurs(why)
}
