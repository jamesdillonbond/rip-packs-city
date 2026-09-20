// Resolves a wallet address to a display name using the saved_wallets table.
// Returns the saved username if any user has saved this wallet, otherwise
// a truncated address like 0xabcd…1234 (or AGzq…SpcQ on Solana).
//
// ⛔ CHAIN-SCOPED KEYS, added 2026-09-20 after the defect was caught LIVE.
// Flow/EVM hex is case-INsensitive, so folding is the correct lookup key there.
// Solana base58 is CASE-SENSITIVE: folding does not normalise a Candy key, it
// DESTROYS it — and because this module's fallback RENDERS the key it just
// folded, the damage surfaced as a fabricated identity rather than as an honest
// absence. Measured in production 2026-09-20 on
// /api/public/insights/top-sales?collection=candy_mlb, which has served Candy
// rows since 2026-09-19:
//
//   buyer_address  1Ttv9XYVPgHRJQwBX2Ccn5GUcgM5BsAWX13kH4gZEQV   (real)
//   buyer_name     1ttv9xyvpghrjqwbx2ccn5gucgm5bsawx13kh4gzeqv   (rendered)
//
// Six mangled addresses in the first three rows. That string resolves to no
// wallet on any chain, so anything built from it — a label, a link — points at
// nothing while reading as a fact.
//
// ⚠ THE HEX PATH BELOW IS DELIBERATELY BYTE-IDENTICAL to what it was, including
// the fold. Widening for a new chain must never narrow the incumbent one, and
// `__tests__/flowty-username-keys-are-chain-scoped.test.ts` pins the hex arm as
// its own no-change control.

import { isSolanaAddress } from "@/lib/address"
import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Wall-clock budget for name resolution, shared across BOTH legs.
 *
 * ⚠ Shared, not per-leg, and that is the whole point. The RPC leg falls through
 * to the `saved_wallets` leg on failure, so two per-leg budgets would let a
 * saturated DB spend the budget TWICE — the bound would double the worst case it
 * was added to cap. The second leg gets whatever the first left.
 *
 * ⚠ Degrading here is cheap and already designed for: `displayName()` falls back
 * to a truncated address, which is not a claim about anything. That is why this
 * budget is short — unlike a board, there is no partial answer worth waiting for.
 */
const RESOLVE_USERNAMES_TIMEOUT_MS = 2_500

/**
 * The lookup key for a resolved-name map. base58 keeps its case; everything
 * else folds exactly as it always did.
 */
export function nameKey(addr: string | null | undefined): string {
  const raw = addr || ""
  return isSolanaAddress(raw) ? raw.trim() : raw.toLowerCase()
}

export function truncateAddress(addr: string): string {
  const raw = addr || ""
  if (isSolanaAddress(raw)) {
    const b58 = raw.trim()
    return b58.length <= 10 ? b58 : b58.slice(0, 6) + "…" + b58.slice(-4)
  }
  const a = raw.toLowerCase()
  if (!a.startsWith("0x")) return a
  if (a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export async function resolveUsernames(
  addresses: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(
    new Set(addresses.map(nameKey).filter(Boolean))
  )
  if (unique.length === 0) return out

  // ⚠ BOUNDED, because a read that is merely SLOW errors nowhere. Both callers
  // (`/analytics/wallets/[address]`, `/moment/[id]`) await this inline, so under
  // DB saturation the page hangs on a streaming shell Vercel logs as a 200 —
  // the fourth occurrence of the unbounded-server-read class. Rejecting on the
  // budget lands in the `catch` each leg already has, and the caller's fallback
  // to a truncated address is the designed degraded state.
  const deadline = Date.now() + RESOLVE_USERNAMES_TIMEOUT_MS
  const remaining = () => Math.max(1, deadline - Date.now())

  // Primary: the broadened analytics_resolve_usernames RPC, which resolves
  // wallet_usernames (the populated Top Shot @handle cache) → seeded_wallets →
  // saved_wallets in priority order. This upgrades every server surface from
  // "saved_wallets only" to the real @handle set as the cache fills.
  try {
    const { data, error } = await withBoardBudget<{ data: unknown; error: unknown }>(
      (supabaseAdmin as any).rpc("analytics_resolve_usernames", { p_addrs: unique }),
      "resolve-usernames-rpc",
      remaining(),
      "wallet/",
    )
    if (!error && data && typeof data === "object") {
      for (const [addr, name] of Object.entries(data as Record<string, string>)) {
        if (name) out.set(nameKey(addr), name)
      }
      if (out.size > 0) return out
    }
  } catch (e) {
    // ⚠ Logged rather than swallowed. A bound that is invisible when it fires is
    // indistinguishable from a bound that never fires, and this repo has already
    // recorded that a permanently-quiet instrument reads exactly like a broken
    // one. The fall-through behaviour is unchanged.
    console.log("[flowty-username] rpc leg:", e instanceof Error ? e.message : e)
  }

  // Fallback: direct saved_wallets read (original behaviour) if the RPC is
  // unavailable for any reason.
  try {
    const { data, error } = await withBoardBudget<{
      data: unknown
      error: unknown
    }>(
      // ⚠ `Promise.resolve` because a PostgREST builder is THENABLE but not a
      // Promise; `withBoardBudget` takes a Promise, and awaiting the builder is
      // what actually issues the request.
      Promise.resolve(
        supabaseAdmin
          .from("saved_wallets")
          .select("wallet_addr, username, display_name")
          .in("wallet_addr", unique),
      ),
      "resolve-usernames-saved",
      remaining(),
      "wallet/",
    )
    if (error || !data) return out
    for (const row of data as Array<{
      wallet_addr: string
      username: string | null
      display_name: string | null
    }>) {
      const addr = nameKey(row.wallet_addr)
      if (!addr) continue
      const name = row.username || row.display_name
      if (name && !out.has(addr)) out.set(addr, name)
    }
  } catch (e) {
    // caller falls back to truncated addresses; see the note on the rpc leg for
    // why this is logged rather than swallowed.
    console.log("[flowty-username] saved_wallets leg:", e instanceof Error ? e.message : e)
  }
  return out
}

export function displayName(addr: string, names: Map<string, string>): string {
  // ⚠ The fallback takes the ORIGINAL `addr`, not the folded key. Passing the
  // key was the bug: on Solana it handed a destroyed address to the renderer.
  return names.get(nameKey(addr)) || truncateAddress(addr)
}
