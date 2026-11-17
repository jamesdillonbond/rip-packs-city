'use client'

// lib/hooks/useOwnFlowWallet.ts
//
// The signed-in reader's own FLOW wallet, for "check a wallet" tools that should
// not ask a signed-in reader to paste their own (2026-09-28). Built on
// useSessionOwner, so it is DISPLAY STATE ONLY — never a capability gate.
//
// `wallet` is null when signed out, when the account has no linked wallet, when
// the identity read failed (degraded: unknown, never guessed), and when the
// linked address is not a Flow address. Lowercased: Flow hex is case-insensitive,
// and this hook never hands back a non-Flow key, so the fold cannot mangle one.

import { isCadenceAddress } from '@/lib/address'
import { useSessionOwner } from '@/lib/hooks/useSessionOwner'

export interface OwnFlowWallet {
  wallet: string | null
  /** True until the session read resolves — hold auto-actions until false. */
  loading: boolean
}

export function ownFlowWalletFrom(walletAddr: string | null | undefined): string | null {
  const w = (walletAddr ?? '').trim()
  return w && isCadenceAddress(w) ? w.toLowerCase() : null
}

export function useOwnFlowWallet(): OwnFlowWallet {
  const s = useSessionOwner()
  return { wallet: s.degraded ? null : ownFlowWalletFrom(s.walletAddr), loading: s.loading }
}
