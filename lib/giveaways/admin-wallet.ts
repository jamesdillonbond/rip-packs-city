// lib/giveaways/admin-wallet.ts
//
// The giveaway ADMIN's wallet actions: connect their own Flow Wallet (a Hybrid
// Custody parent of their Dapper account) and sign delivery batches. RPC never
// holds a key or a moment (Trevor, 2026-09-29). Connecting goes through
// lib/giveaways/flow-wallet-connect.ts, the one module that opens a wallet
// picker; only app/admin/giveaways/AdminGiveawaysClient.tsx imports this file
// (pinned by __tests__/no-client-wallet-connect.test.ts).

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"
import { DELIVER_BATCH_CADENCE, DELIVER_GAS_LIMIT, DELIVER_OWN_BATCH_CADENCE } from "@/lib/giveaways/deliver-cadence"
import type { DeliveryBatch } from "@/lib/giveaways/deliver"

export {
  DISCOVERY_AUTHN_ENDPOINT,
  WALLETCONNECT_PROJECT_ID,
  connectFlowWallet as connectAdminWallet,
  disconnectFlowWallet as disconnectAdminWallet,
  prepareWalletConnect,
} from "@/lib/giveaways/flow-wallet-connect"

export interface SentBatch {
  txId: string
}

/**
 * Asks the connected wallet to sign one delivery batch, then waits for the
 * transaction to SEAL. Throws if the wallet declines or the transaction
 * reverts — a batch is only reported sent when the chain says it executed.
 */
export async function sendDeliveryBatch(batch: DeliveryBatch): Promise<SentBatch> {
  initFcl()
  // "own": the connected Flow Wallet's own moments; "linked": a child account's, via Hybrid Custody
  const txId: string = await fcl.mutate({
    cadence: batch.kind === "own" ? DELIVER_OWN_BATCH_CADENCE : DELIVER_BATCH_CADENCE,
    args: (arg: typeof fcl.arg, t: typeof fcl.t) =>
      batch.kind === "own"
        ? [arg(batch.momentIDs, t.Array(t.UInt64)), arg(batch.recipients, t.Array(t.Address))]
        : [
            arg(batch.source, t.Address),
            arg(batch.providerControllerID as string, t.UInt64),
            arg(batch.momentIDs, t.Array(t.UInt64)),
            arg(batch.recipients, t.Array(t.Address)),
          ],
    // proposer, payer and the single authorizer all default to the connected
    // wallet (fcl.currentUser) — the admin signs and pays the network fee.
    limit: DELIVER_GAS_LIMIT,
  })
  const sealed = (await fcl.tx(txId).onceSealed()) as { errorMessage?: string; statusCode?: number }
  if (sealed?.errorMessage || (sealed?.statusCode ?? 0) !== 0) {
    throw new Error(`Transaction ${txId} failed: ${sealed?.errorMessage || `status ${sealed?.statusCode}`}`)
  }
  return { txId }
}
