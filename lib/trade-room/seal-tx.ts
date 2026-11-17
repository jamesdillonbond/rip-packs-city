// lib/trade-room/seal-tx.ts
//
// 2026-11-13 (review): `sealed` checked that every Moment LANDED but stored whatever 64-hex
// `tx_id` the caller sent, and the room page links that id on flowscan as "the transaction
// that sealed this trade". Either party could record an unrelated transaction. The id is now
// read from the chain before it is stored: it must exist, have executed without error, and be
// authorized by BOTH of the room's wallets (the trade is a two-authorizer transaction).
//
// A read that fails is a 503 + retryable, never "not this trade".

import { TradeRoomError } from "@/lib/trade-room/store"

export const FLOW_REST = process.env.FLOW_ACCESS_NODE || "https://rest-mainnet.onflow.org"

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

const sans0x = (a: string) => a.trim().toLowerCase().replace(/^0x/, "")

/** Statuses at which a transaction's effects are final on chain. */
const FINAL = new Set(["sealed", "executed"])

/**
 * Throws unless `txId` is a final, error-free transaction authorized by every address in
 * `signers`. 409 `bad_tx` when the chain says it is not this trade; 503 when it can't be read.
 */
export async function assertSealTx(txId: string, signers: readonly string[], fetchFn: FetchFn = fetch): Promise<void> {
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

  let txBody: { authorizers?: unknown }
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
  if (missing.length) throw notOurs("it wasn't signed by both of this room's wallets")
}
