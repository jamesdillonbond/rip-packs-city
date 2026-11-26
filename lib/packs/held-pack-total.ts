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
import { packsByCollection, sumHeldPacks, type CollectionPacks, type HeldPackValueRow, type HeldPacksTotal } from "@/lib/dashboard/held-packs"

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

// 2026-11-22 (inbox 2026-11-22T0440Z, Trevor "Apply it"): the biggest pack wallets take ~19 s
// and hit the function's 20 s ceiling. wallet_pack_value_cache is filled hourly in the
// background (refresh_wallet_pack_value_cache, no request ceiling there) and on each live
// success. A cache row younger than FRESH_MS is served as is; otherwise the live read runs,
// and if it FAILS a row up to STALE_OK_MS old is served instead — a failed read never adds $0.
export const CACHE_FRESH_MS = 30 * 60 * 1000
export const CACHE_STALE_OK_MS = 24 * 60 * 60 * 1000

type CacheRow = { wallet_addr: string; value: HeldPackValueRow; computed_at: string }

/** Pure: which cached value (if any) to serve, given the live answer and the clock. */
export function pickHeldValue(
  cached: CacheRow | undefined,
  live: HeldPackValueRow | null | "skipped",
  now: number,
): HeldPackValueRow | null {
  const age = cached ? now - Date.parse(cached.computed_at) : Infinity
  if (live === "skipped") return cached && age < CACHE_FRESH_MS ? cached.value : null
  if (live) return live
  return cached && age < CACHE_STALE_OK_MS ? cached.value : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readHeldPackTotal(sb: any, addrs: string[], label: string, now: number = Date.now()): Promise<HeldPacksTotal> {
  // One cache read for every address. A failed cache read is an empty cache, never an error.
  const cache = new Map<string, CacheRow>()
  if (addrs.length > 0) {
    try {
      const { data, error } = await boundedRead(
        sb.from("wallet_pack_value_cache").select("wallet_addr, value, computed_at").in("wallet_addr", addrs),
        `${label}/wallet_pack_value_cache`,
      )
      if (!error && Array.isArray(data)) {
        for (const r of data as CacheRow[]) {
          if (r && typeof r.wallet_addr === "string" && r.value && typeof r.value === "object" && Number.isFinite(Date.parse(r.computed_at))) {
            cache.set(r.wallet_addr, r)
          }
        }
      }
    } catch {
      /* empty cache */
    }
  }
  const answers = await Promise.all(addrs.map(async (addr): Promise<HeldPackValueRow | null> => {
    const cached = cache.get(addr)
    const fresh = pickHeldValue(cached, "skipped", now)
    if (fresh) return fresh
    let live: HeldPackValueRow | null = null
    try {
      const { data, error } = await boundedRead(
        sb.rpc("wallet_held_pack_value", { p_wallet: addr }),
        `${label}/wallet_held_pack_value`,
        READ_BUDGET_MS,
      )
      if (!error && data && typeof data === "object" && !("error" in data)) live = data as HeldPackValueRow
    } catch {
      live = null
    }
    if (live) {
      // Best effort: a failed cache write changes nothing the reader sees.
      try {
        const { error: cacheError } = await sb.from("wallet_pack_value_cache")
          .upsert({ wallet_addr: addr, value: live, computed_at: new Date(now).toISOString() }, { onConflict: "wallet_addr" })
        if (cacheError) console.error(`[${label}] wallet_pack_value_cache write failed:`, cacheError.message)
      } catch {
        /* ignore */
      }
    }
    return pickHeldValue(cached, live, now)
  }))
  const byWallet: Record<string, Record<string, CollectionPacks> | null> = {}
  addrs.forEach((addr, i) => {
    const a = answers[i]
    if (a === null) { byWallet[addr] = null; return }
    const split = packsByCollection(a)
    if (split) byWallet[addr] = split
  })
  return { ...sumHeldPacks(answers), byWallet }
}
