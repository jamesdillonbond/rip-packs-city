// Resolves a Flow address to a display name using the saved_wallets table.
// Returns the saved username if any user has saved this wallet, otherwise
// a truncated address like 0xabcd…1234.

import { supabaseAdmin } from "@/lib/supabase"

export function truncateAddress(addr: string): string {
  const a = (addr || "").toLowerCase()
  if (!a.startsWith("0x")) return a
  if (a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export async function resolveUsernames(
  addresses: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(
    new Set(addresses.map((a) => (a || "").toLowerCase()).filter(Boolean))
  )
  if (unique.length === 0) return out
  try {
    const { data, error } = await supabaseAdmin
      .from("saved_wallets")
      .select("wallet_addr, username, display_name")
      .in("wallet_addr", unique)
    if (error || !data) return out
    for (const row of data as Array<{
      wallet_addr: string
      username: string | null
      display_name: string | null
    }>) {
      const addr = (row.wallet_addr || "").toLowerCase()
      if (!addr) continue
      const name = row.username || row.display_name
      if (name && !out.has(addr)) out.set(addr, name)
    }
  } catch {
    // swallow — caller falls back to truncated addresses
  }
  return out
}

export function displayName(addr: string, names: Map<string, string>): string {
  const a = (addr || "").toLowerCase()
  return names.get(a) || truncateAddress(a)
}
