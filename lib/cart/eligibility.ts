// lib/cart/eligibility.ts
//
// Single source of truth for "can this listing be bought via the Flow Wallet
// cart?". Top Shot-sourced listings (source === 'topshot') live in Dapper
// custody and can only be purchased through a Dapper cart, which we don't
// support yet. Everything cart-related — addToCart buttons, chatbot deal
// cards, cart drawer validations — should call isCartEligible before
// offering a "+ Cart" action.

import { NFT_STOREFRONT_V2_ADDRESS } from '@/lib/cadence/purchase-moment-flow-wallet'

export type CartEligibilityReason =
  | 'ok'
  | 'missing_listing_id'
  | 'missing_storefront'
  | 'missing_price'
  | 'dapper_only'
  | 'unsupported_collection'
  | 'unsupported_currency'

export interface CartEligibilityInput {
  listingResourceID?: string | null
  storefrontAddress?: string | null
  expectedPrice?: number | null
  /**
   * Origin of the listing. 'flowty' and NFTStorefrontV2-based feeds are
   * eligible; 'topshot' (Dapper custody) is not.
   */
  source?: string | null
  /**
   * Payment currency. FLOW/DUC on NFTStorefrontV2 is supported; everything
   * else (FUT, USDC.e offers, non-storefront listings) is not.
   */
  paymentToken?: string | null
  /**
   * Contract address of the marketplace. Used to assert that non-Flowty
   * listings are on NFTStorefrontV2 rather than some other storefront.
   */
  marketplaceContractAddress?: string | null
}

const CART_ELIGIBLE_CURRENCIES = new Set(['FLOW', 'DUC'])

export function cartEligibilityReason(input: CartEligibilityInput): CartEligibilityReason {
  if (!input.listingResourceID) return 'missing_listing_id'
  if (!input.storefrontAddress) return 'missing_storefront'
  if (!input.expectedPrice || input.expectedPrice <= 0) return 'missing_price'

  const source = (input.source ?? '').toLowerCase()
  if (source === 'topshot' || source === 'dapper' || source === 'pinnacle') {
    return 'dapper_only'
  }

  // Flowty-sourced deals are always on NFTStorefrontV2 by construction.
  if (source === 'flowty') return 'ok'

  // For everything else we require (a) a supported currency and (b) a
  // storefront on NFTStorefrontV2. If the caller didn't tell us the
  // marketplace contract address, assume NFTStorefrontV2 (the default
  // storefront for all cart-surfaced listings).
  const currency = (input.paymentToken ?? '').toUpperCase()
  if (currency && !CART_ELIGIBLE_CURRENCIES.has(currency)) {
    return 'unsupported_currency'
  }

  const marketplace = (input.marketplaceContractAddress ?? NFT_STOREFRONT_V2_ADDRESS).toLowerCase()
  if (marketplace !== NFT_STOREFRONT_V2_ADDRESS.toLowerCase()) {
    return 'unsupported_collection'
  }

  return 'ok'
}

export function isCartEligible(input: CartEligibilityInput): boolean {
  return cartEligibilityReason(input) === 'ok'
}

export function cartIneligibleTooltip(reason: CartEligibilityReason): string {
  switch (reason) {
    case 'ok':
      return ''
    case 'dapper_only':
      return 'Dapper purchase only — cart coming soon.'
    case 'unsupported_currency':
      return 'Currency not supported by Flow Wallet cart yet.'
    case 'unsupported_collection':
      return 'Marketplace not supported by Flow Wallet cart.'
    case 'missing_listing_id':
    case 'missing_storefront':
    case 'missing_price':
      return 'Listing is missing on-chain data required to cart.'
  }
}
