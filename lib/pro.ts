// lib/pro.ts — RPC Pro subscription helpers
// Uses the service role client to query pro_users table

import { supabaseAdmin } from "@/lib/supabase"

/**
 * Check if a wallet address has an active Pro subscription.
 * Returns true if a row exists with expires_at null (lifetime) or expires_at > now.
 */
export async function isProUser(walletAddress: string): Promise<boolean> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pro_users")
    .select("id, expires_at")
    .eq("wallet_address", walletAddress.toLowerCase())
    .limit(1)
    .maybeSingle()

  if (error || !data) return false
  if (data.expires_at === null) return true
  return new Date(data.expires_at) > new Date()
}

/**
 * Get the full Pro status for a wallet address.
 */
export async function getProStatus(walletAddress: string): Promise<{
  isPro: boolean
  plan: string | null
  expiresAt: string | null
}> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pro_users")
    .select("plan, expires_at")
    .eq("wallet_address", walletAddress.toLowerCase())
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return { isPro: false, plan: null, expiresAt: null }
  }

  const isPro = data.expires_at === null || new Date(data.expires_at) > new Date()
  return {
    isPro,
    plan: data.plan,
    expiresAt: data.expires_at,
  }
}
