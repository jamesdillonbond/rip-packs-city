// lib/storage-fix/wallet.ts
//
// The wallet half of the admin-only storage-fix console (/admin/storage-fix; Trevor,
// 2026-11-05: the tool and its wallet sign-in live behind the admin page, nowhere else).
// Imported ONLY by app/admin/storage-fix/StorageFixClient.tsx (pinned by
// __tests__/no-client-wallet-connect.test.ts). RPC never holds a key: the operator's own
// Flow Wallet proposes, pays and authorizes ONE transaction, and its FLOW goes to the
// stuck account.
//
// It can sign exactly two texts (lib/storage-fix/cadence.ts): the Dapper refill
// (DapperStorageRent.fundedRefillV2 — the only way FLOW reaches a Dapper wallet) and a
// plain FLOW transfer for any other account. Nothing here takes Cadence as input.

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"
import { normalizeFlowAddress } from "@/lib/address"
import { DAPPER_REFILL_CADENCE, PLAIN_SEND_CADENCE, STORAGE_FIX_GAS_LIMIT } from "@/lib/storage-fix/cadence"
import { errorText } from "@/lib/giveaways/view-format"
import {
  SealUnconfirmedError,
  SLOW_WALLET_MS,
  isExecutionError,
  slowWalletHint,
  startNetworkTrace,
  walletChannel,
  whenVisible,
  type WalletChannel,
} from "@/lib/giveaways/admin-wallet"

export { SealUnconfirmedError }
export { connectFlowWallet, disconnectFlowWallet } from "@/lib/giveaways/flow-wallet-connect"

export type StorageFixKind = "dapper_refill" | "plain_send"

export interface StorageFixRequest {
  kind: StorageFixKind
  receiver: string
  /** UFix64 literal, 8 decimals (lib/storage-fix/check.ts parseFixAmount). */
  amount: string
}

const SEAL_READ_ATTEMPTS = 3
const UFIX64 = /^\d{1,3}\.\d{8}$/

/** The exact text and arguments a request signs; refuses anything malformed BEFORE the wallet opens. */
export function buildStorageFix(req: StorageFixRequest): { cadence: string; receiver: string; amount: string } {
  const receiver = normalizeFlowAddress(req?.receiver)
  if (!receiver) throw new Error("The receiver is not a Flow address.")
  if (!UFIX64.test(String(req?.amount ?? "")) || !(Number(req.amount) > 0)) throw new Error("The amount is not a FLOW amount.")
  const cadence = req.kind === "dapper_refill" ? DAPPER_REFILL_CADENCE : req.kind === "plain_send" ? PLAIN_SEND_CADENCE : null
  if (!cadence) throw new Error("Unknown fix.")
  return { cadence, receiver, amount: req.amount }
}

/** Resolves to `fallback` if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    )
  })
}

/**
 * Asks the connected Flow Wallet to sign and pay the fix, then waits for the SEAL.
 * Throws if the wallet declines or the transaction reverts; a submitted transaction whose
 * seal cannot be read is a SealUnconfirmedError (it may have executed: never resend).
 */
export async function sendStorageFix(
  req: StorageFixRequest,
  opts: { onSlow?: (hint: string) => void; slowMs?: number } = {},
): Promise<{ txId: string }> {
  const tx = buildStorageFix(req)
  initFcl()
  const trace = startNetworkTrace()
  let channel: WalletChannel = "unknown"
  const slow = opts.onSlow
    ? setTimeout(
        () => opts.onSlow?.(slowWalletHint(channel, trace.waitingOn(), trace.blocked(), { seen: trace.seen(), logged: trace.logged() })),
        opts.slowMs ?? SLOW_WALLET_MS,
      )
    : null
  let txId: string
  try {
    channel = await within(walletChannel(), 1_500, "unknown")
    txId = await fcl.mutate({
      cadence: tx.cadence,
      args: (arg: typeof fcl.arg, t: typeof fcl.t) => [arg(tx.receiver, t.Address), arg(tx.amount, t.UFix64)],
      // proposer, payer and the single authorizer all default to the connected wallet
      limit: STORAGE_FIX_GAS_LIMIT,
    })
  } catch (e) {
    throw new Error(errorText(e) + trace.describe())
  } finally {
    if (slow) clearTimeout(slow)
    trace.stop()
  }
  let lastReadError = ""
  for (let attempt = 1; attempt <= SEAL_READ_ATTEMPTS; attempt++) {
    let sealed: { errorMessage?: string; statusCode?: number }
    try {
      await whenVisible()
      sealed = (await fcl.tx(txId).onceSealed()) as { errorMessage?: string; statusCode?: number }
    } catch (e) {
      if (isExecutionError(e)) throw new Error(`Transaction ${txId} failed: ${errorText(e)}`)
      lastReadError = errorText(e)
      continue
    }
    if (sealed?.errorMessage || (sealed?.statusCode ?? 0) !== 0) {
      throw new Error(`Transaction ${txId} failed: ${sealed?.errorMessage || `status ${sealed?.statusCode}`}`)
    }
    return { txId }
  }
  throw new SealUnconfirmedError(txId, lastReadError)
}
