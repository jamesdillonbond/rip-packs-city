import * as fcl from '@onflow/fcl'

const APP_IDENTIFIER = 'rip-packs-city'

const IS_MAINNET = process.env.NEXT_PUBLIC_FLOW_NETWORK !== 'testnet'

const MAINNET_CONFIG = {
  'flow.network': 'mainnet',
  'accessNode.api': 'https://rest-mainnet.onflow.org',
  'discovery.wallet': 'https://accounts.meetdapper.com/fcl/authn-restricted',
  'discovery.wallet.method': 'POP/RPC',
  'app.detail.title': 'Rip Packs City',
  'app.detail.icon': 'https://rip-packs-city.vercel.app/rip-packs-city-logo.png',
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
  'discovery.wallet': 'https://fcl-discovery.onflow.org/testnet/authn',
  'discovery.wallet.method': 'POP/RPC',
  'app.detail.title': 'Rip Packs City (Testnet)',
  'app.detail.icon': 'https://rip-packs-city.vercel.app/rip-packs-city-logo.png',
}

let initialized = false

export function initFcl() {
  if (initialized) return
  initialized = true
  fcl.config(IS_MAINNET ? MAINNET_CONFIG : TESTNET_CONFIG)
}

// Default export for compatibility with any existing imports of this module
export default fcl