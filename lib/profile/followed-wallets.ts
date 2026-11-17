// lib/profile/followed-wallets.ts
//
// Shared pieces of the follow-a-wallet feature (2026-11-16): the route
// (/api/profile/followed-wallets) and the friend feed (/api/profile/activity)
// must agree on how a wallet is keyed, or a followed Candy wallet matches no
// sale.

import { normalizeAddress } from "@/lib/address"
import { isOnChainAddress } from "@/lib/postgrest-safe"

/** A followed-wallet list is a feed input, not a census — bound it. */
export const MAX_FOLLOWED_WALLETS = 50

/**
 * Normalised address (hex folded, base58 verbatim), or null when the input is
 * not an on-chain address. Only values that pass here are stored, so every
 * stored value is safe to splice into a PostgREST `.in.(...)` filter.
 */
export function parseFollowedWallet(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const addr = normalizeAddress(raw)
  return isOnChainAddress(addr) ? addr : null
}

/** saved_wallets stores some Flow rows with and some without the 0x prefix. */
export function savedWalletAddressVariants(addr: string): string[] {
  if (/^0x[0-9a-f]+$/.test(addr)) return [addr, addr.slice(2)]
  return [addr]
}
