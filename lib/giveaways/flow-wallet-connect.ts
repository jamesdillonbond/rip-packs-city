// lib/giveaways/flow-wallet-connect.ts
//
// ⚠ THE ONE PLACE RPC OPENS A WALLET PICKER (fcl.authenticate + wallet discovery).
//
// RPC has no wallet sign-in for users (Trevor, 2026-08-08; pinned by
// __tests__/no-client-wallet-connect.test.ts). Two narrow, named exceptions use
// this module, and nothing else may:
//   * lib/giveaways/admin-wallet.ts — the giveaway ADMIN connects their own Flow
//     Wallet on /admin/giveaways to sign delivery (Trevor, 2026-09-29).
//   * lib/giveaways/claim-wallet.ts — a giveaway WINNER connects Flow Wallet on
//     /giveaways/<slug> to say where their pack goes, their Flow Wallet or a
//     Dapper account linked to it (Trevor, 2026-10-03: "Let's plan on using Flow
//     Wallet to claim instead of Dapper"). Connect only — it never signs.
// The guard pins this module, its two importers and theirs.
//
// Wallet discovery is configured HERE — never in lib/chains/flow/flow.ts, whose
// import side effect runs on every page.

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"

const DISCOVERY = "https://fcl-discovery.onflow.org/authn"

/**
 * WalletConnect is what lists the Flow Wallet MOBILE app in the picker (the
 * desktop extension appears on its own; without WalletConnect a phone sees only
 * Blocto — Trevor, 2026-09-29). FCL loads its WalletConnect plugin when
 * `walletconnect.projectId` is configured, asynchronously, so it is set when this
 * module loads (when the admin console or a claim form mounts) rather than
 * at click time, when the picker would open before the plugin registered.
 * NEXT_PUBLIC_WALLETCONNECT_ID is a public project id (already in Vercel).
 */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_ID ?? ""

/**
 * FCL's WalletConnect loader asks the discovery API which wallets exist as soon
 * as the project id is set; without this endpoint it throws `INVARIANT
 * "discovery.authn.endpoint" in config must be defined` at page load (Trevor's
 * console, 2026-09-29). The host is already in this page's connect-src.
 */
export const DISCOVERY_AUTHN_ENDPOINT = "https://fcl-discovery.onflow.org/api/authn"

export function prepareWalletConnect(projectId: string = WALLETCONNECT_PROJECT_ID): boolean {
  if (typeof window === "undefined" || !projectId) return false
  initFcl()
  fcl.config().put("discovery.authn.endpoint", DISCOVERY_AUTHN_ENDPOINT)
  fcl.config().put("walletconnect.projectId", projectId)
  return true
}

prepareWalletConnect()

/** Opens Flow's wallet picker; resolves to the connected address. */
export async function connectFlowWallet(): Promise<string> {
  initFcl()
  fcl.config().put("discovery.wallet", DISCOVERY)
  const user = (await fcl.authenticate()) as { addr?: string | null } | undefined
  const address = user?.addr?.toLowerCase() ?? null
  if (!address) throw new Error("The wallet did not return an address.")
  return address
}

export async function disconnectFlowWallet(): Promise<void> {
  await fcl.unauthenticate()
}
