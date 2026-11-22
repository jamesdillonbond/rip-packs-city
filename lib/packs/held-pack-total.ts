// lib/packs/held-pack-total.ts
//
// SERVER-ONLY. Sealed packs held across a set of wallets, at the lowest live ask —
// wallet_held_pack_value(p_wallet) once per distinct Flow address, in parallel.
// Shared by /api/profile/held-pack-value (dashboard) and
// /api/public/profile/<username>/packs (public profile). Measured 2026-11-21:
// 0.2–3.1 s per wallet. A wallet whose read fails is counted in walletsFailed,
// never folded in as $0.

import { boundedRead } from "@/lib/api/bounded-read"
import { isCadenceAddress, normalizeAddress } from "@/lib/address"
import { sumHeldPacks, type HeldPackValueRow, type HeldPacksTotal } from "@/lib/dashboard/held-packs"

// wallet_held_pack_value carries its own 20 s statement_timeout; wait just past it.
const READ_BUDGET_MS = 21_000
// Cap the fan-out (one Dapper wallet per account since 2026-11-07; older accounts a handful).
export const MAX_PACK_WALLETS = 12

/** Distinct Flow addresses only — a Solana or Aptos address cannot hold a pack. */
export function packWalletAddresses(raw: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    raw.map((a) => normalizeAddress(a ?? "")).filter((a) => a && isCadenceAddress(a)),
  )).slice(0, MAX_PACK_WALLETS)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readHeldPackTotal(sb: any, addrs: string[], label: string): Promise<HeldPacksTotal> {
  const answers = await Promise.all(addrs.map(async (addr): Promise<HeldPackValueRow | null> => {
    try {
      const { data, error } = await boundedRead(
        sb.rpc("wallet_held_pack_value", { p_wallet: addr }),
        `${label}/wallet_held_pack_value`,
        READ_BUDGET_MS,
      )
      if (error || !data || typeof data !== "object" || "error" in data) return null
      return data as HeldPackValueRow
    } catch {
      return null
    }
  }))
  return sumHeldPacks(answers)
}
