// lib/giveaways/admin-wallet.ts
//
// ⚠ THE ONE PLACE RPC CONNECTS A WALLET, and only for the giveaway ADMIN.
//
// RPC has no wallet sign-in for users (Trevor, 2026-08-08; pinned by
// __tests__/no-client-wallet-connect.test.ts). On 2026-09-29 Trevor approved one
// narrow exception: on /admin/giveaways, the admin connects THEIR OWN Flow Wallet
// (a Hybrid Custody parent of their Dapper account) and approves one
// transaction that delivers claimed giveaway moments. RPC never holds a key or a
// moment. The guard allows exactly this file, and pins that only
// app/admin/giveaways/AdminGiveawaysClient.tsx imports it.
//
// Wallet discovery is configured HERE, at connect time — never in
// lib/chains/flow/flow.ts, whose import side effect runs on every page.

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"
import { DELIVER_BATCH_CADENCE, DELIVER_GAS_LIMIT } from "@/lib/giveaways/deliver-cadence"
import type { DeliveryBatch } from "@/lib/giveaways/deliver"

const DISCOVERY = "https://fcl-discovery.onflow.org/authn"

/**
 * WalletConnect is what lists the Flow Wallet MOBILE app in the picker (the
 * desktop extension appears on its own; without WalletConnect a phone sees only
 * Blocto — Trevor, 2026-09-29). FCL loads its WalletConnect plugin when
 * `walletconnect.projectId` is configured, asynchronously, so it is set when this
 * module loads (it is imported only by the admin giveaway console) rather than
 * at click time, when the picker would open before the plugin registered.
 * NEXT_PUBLIC_WALLETCONNECT_ID is a public project id (already in Vercel).
 */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_ID ?? ""

export function prepareWalletConnect(projectId: string = WALLETCONNECT_PROJECT_ID): boolean {
  if (typeof window === "undefined" || !projectId) return false
  initFcl()
  fcl.config().put("walletconnect.projectId", projectId)
  return true
}

prepareWalletConnect()

/** Opens Flow's wallet picker; resolves to the connected address. */
export async function connectAdminWallet(): Promise<string> {
  initFcl()
  fcl.config().put("discovery.wallet", DISCOVERY)
  const user = (await fcl.authenticate()) as { addr?: string | null } | undefined
  const address = user?.addr?.toLowerCase() ?? null
  if (!address) throw new Error("The wallet did not return an address.")
  return address
}

export async function disconnectAdminWallet(): Promise<void> {
  await fcl.unauthenticate()
}

export interface SentBatch {
  txId: string
}

/**
 * Asks the connected wallet to sign one delivery batch, then waits for the
 * transaction to SEAL. Throws if the wallet declines or the transaction
 * reverts — a batch is only reported sent when the chain says it executed.
 */
export async function sendDeliveryBatch(
  plan: { child: string; providerControllerID: string },
  batch: DeliveryBatch,
): Promise<SentBatch> {
  initFcl()
  const txId: string = await fcl.mutate({
    cadence: DELIVER_BATCH_CADENCE,
    args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
      arg(plan.child, t.Address),
      arg(plan.providerControllerID, t.UInt64),
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
