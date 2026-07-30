import * as fcl from '@onflow/fcl'

const APP_IDENTIFIER = 'rip-packs-city'

const IS_MAINNET = process.env.NEXT_PUBLIC_FLOW_NETWORK !== 'testnet'

// CORE (chain) config only — deliberately NO `discovery.*` keys.
//
// `discovery.wallet` is a GLOBAL FCL singleton. This module auto-initialises on
// import (see the bottom of the file), and that side effect is load-bearing: ~14
// server-side API routes do `import fcl from "@/lib/chains/flow/flow"` and call
// `fcl.query()` without ever calling initFcl(), so they rely on the import to set
// `accessNode.api` + the `0x…` contract placeholders.
//
// Wallet DISCOVERY is a separate concern with exactly ONE owner:
// lib/chains/flow/fcl-config.ts. Never add a `discovery.*` key here — an import
// side effect that mutates wallet discovery races the sign-in flow and the winner
// becomes import-order dependent (that was the 2026-07-29 defect: this file shipped
// Dapper-restricted discovery to /dashboard alongside fcl-config's self-custody
// discovery). `__tests__/fcl-discovery-single-owner.test.ts` pins the invariant.
const MAINNET_CONFIG = {
  'flow.network': 'mainnet',
  'accessNode.api': 'https://rest-mainnet.onflow.org',
  'app.detail.title': 'Rip Packs City',
  'app.detail.icon': 'https://www.rippackscity.com/rip-packs-city-logo.png',
  'app.detail.id': APP_IDENTIFIER,
  '0xFungibleToken': '0xf233dcee88fe0abe',
  '0xNonFungibleToken': '0x1d7e57aa55817448',
  '0xMetadataViews': '0x1d7e57aa55817448',
  '0xNFTStorefrontV2': '0x3cdbb3d569211ff3',
  '0xTopShot': '0x0b2a3299cc857e29',
  '0xDapperUtilityCoin': '0xead892083b3e2c6c',
  '0xDapperMerchant': '0xc1e4f4f4c4257510',
}

const TESTNET_CONFIG = {
  'flow.network': 'testnet',
  'accessNode.api': 'https://rest-testnet.onflow.org',
  'app.detail.title': 'Rip Packs City (Testnet)',
  'app.detail.icon': 'https://www.rippackscity.com/rip-packs-city-logo.png',
}

let initialized = false

/**
 * Configure FCL's CHAIN config (network, access node, contract placeholders).
 *
 * Sets no wallet discovery — to connect a wallet, call `configureFcl()` from
 * lib/chains/flow/fcl-config.ts, which owns `discovery.wallet` outright.
 */
export function initFcl() {
  if (initialized) return
  initialized = true
  fcl.config(IS_MAINNET ? MAINNET_CONFIG : TESTNET_CONFIG)
}

// AUTO-INIT: ensure the CHAIN config exists on first import. Load-bearing for the
// server-side routes that import the default export and call fcl.query() directly
// (prevents INVARIANT errors on cold starts). Safe as an import side effect only
// because it no longer touches wallet discovery — see the note above MAINNET_CONFIG.
initFcl()

// Default export for compatibility with any existing imports of this module
export default fcl