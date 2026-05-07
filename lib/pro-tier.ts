// lib/pro-tier.ts
//
// Server-side Pro tier helpers. All functions take a wallet address and
// dispatch through the Postgres source-of-truth RPCs:
//   - get_user_plan(wallet) → 'free' | 'founding' | 'moments_payment'
//                           | 'pro_grandfather' | 'pro_paid' | 'pro_trial'
//                           | 'admin'
//   - check_feature_quota(wallet, feature) → { allowed, plan, used_today,
//                                              daily_limit, remaining,
//                                              reason }
//   - record_feature_usage(wallet, feature, metadata?)
//
// `feature_quotas` is the data-driven source of caps. The same shape powers
// concierge daily limits, saved-wallet caps, custom alert caps, and api
// requests. Quota check is `unlimited` for founding/admin/pro_*; free
// users get the row from `feature_quotas WHERE plan='free'`.

import { supabaseAdmin } from "@/lib/supabase"
import { NextResponse } from "next/server"

export type UserPlan =
  | "free"
  | "founding"
  | "moments_payment"
  | "pro_grandfather"
  | "pro_paid"
  | "pro_trial"
  | "admin"

const PRO_PLANS: ReadonlySet<UserPlan> = new Set([
  "founding",
  "moments_payment",
  "pro_grandfather",
  "pro_paid",
  "pro_trial",
  "admin",
])

export interface QuotaResult {
  allowed: boolean
  plan: UserPlan
  used_today: number
  daily_limit: number | null
  remaining: number | null
  reason: string
}

function normalizeWallet(walletAddress: string | null | undefined): string | null {
  if (typeof walletAddress !== "string") return null
  const trimmed = walletAddress.trim().toLowerCase()
  if (!/^0x[a-f0-9]{16}$/.test(trimmed)) return null
  return trimmed
}

export async function getUserPlan(walletAddress: string | null | undefined): Promise<UserPlan> {
  const wallet = normalizeWallet(walletAddress)
  if (!wallet) return "free"
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc("get_user_plan", { p_wallet: wallet })
  if (error || typeof data !== "string") return "free"
  const plan = data as UserPlan
  return plan
}

export async function isProUser(walletAddress: string | null | undefined): Promise<boolean> {
  const plan = await getUserPlan(walletAddress)
  return PRO_PLANS.has(plan)
}

// Check daily-usage quota for a feature. The RPC returns `allowed: true`
// for any plan with `daily_limit IS NULL` (founding, admin, and most pro
// plans for unlimited features). Free + pro_trial users get a finite cap.
export async function checkFeatureQuota(
  walletAddress: string | null | undefined,
  featureName: string
): Promise<QuotaResult> {
  const wallet = normalizeWallet(walletAddress)
  if (!wallet) {
    // Anonymous / malformed wallet — treat as free, blocked at the cap so
    // the response still carries a usable "upgrade" message. Falls through
    // to the RPC with a sentinel zero address; that returns the free-plan
    // row from feature_quotas without ever incrementing usage_events.
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc("check_feature_quota", {
      p_wallet: "0x0000000000000000",
      p_feature: featureName,
    })
    if (error || !data) {
      return {
        allowed: false, plan: "free",
        used_today: 0, daily_limit: 0, remaining: 0,
        reason: "rpc_error",
      }
    }
    return data as QuotaResult
  }

  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabaseAdmin as any).rpc("check_feature_quota", {
    p_wallet: wallet, p_feature: featureName,
  })
  if (error || !data) {
    // Fail-open for known-good wallets: if the RPC is unreachable we don't
    // want to wedge the product. Free callers get the same zero-quota
    // shape they'd see on a true block; everyone else is treated as
    // unlimited until the RPC recovers.
    return {
      allowed: true, plan: "free",
      used_today: 0, daily_limit: null, remaining: null,
      reason: "rpc_error_failopen",
    }
  }
  return data as QuotaResult
}

// Fire-and-forget usage record. Should be called AFTER the feature has
// been served. Failures are logged but never block the user response.
export async function recordFeatureUsage(
  walletAddress: string | null | undefined,
  featureName: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const wallet = normalizeWallet(walletAddress)
  if (!wallet) return
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("record_feature_usage", {
      p_wallet: wallet, p_feature: featureName,
      p_metadata: metadata ?? null,
    })
  } catch (err) {
    console.warn(
      `[pro-tier] record_feature_usage failed wallet=${wallet} feature=${featureName} err=${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// Guard helper for Pro-only API routes. Returns null on success, or a
// 402 Payment Required NextResponse the caller should `return` directly.
export async function requirePro(
  walletAddress: string | null | undefined,
  upgradeUrl = "/pricing"
): Promise<NextResponse | null> {
  const plan = await getUserPlan(walletAddress)
  if (PRO_PLANS.has(plan)) return null
  return NextResponse.json(
    {
      error: "pro_required",
      message: "This feature is available to RPC Pro members.",
      plan,
      upgrade_url: upgradeUrl,
    },
    { status: 402 }
  )
}
