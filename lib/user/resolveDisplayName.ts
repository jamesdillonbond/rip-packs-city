// lib/user/resolveDisplayName.ts
//
// Server-side display-name resolver for the dashboard, mobile nav profile
// tab, and any header that currently shows a wallet address. Given an
// auth.users.id (and optionally email + wallet), returns the highest-
// preference name from this chain:
//
//   1. user_profiles.display_name      (canonical, set on /profile/edit
//                                        once that page writes here too)
//   2. profile_bio.display_name        (current /profile/edit destination —
//                                        kept in the chain for back-compat)
//   3. allow_list.username             (Top Shot Dapper username from invite)
//   4. <local-part of auth.users.email>
//   5. shortAddress(wallet_addr)       (0x1234…abcd; first 6 + last 4 hex)
//
// At each step we apply the profanity guard from lib/user/blocklist.ts so
// a user-controlled username/email-prefix can't surface a slur in the UI.
// If every candidate fails the guard, fall through to the truncated wallet,
// and if that's also missing return "Collector" as a last resort.

import { supabaseAdmin } from "@/lib/supabase"
import { isBlocklisted } from "./blocklist"

export type ResolvedDisplayName = {
  display_name: string
  source:
    | "user_profiles"
    | "profile_bio"
    | "allow_list_username"
    | "email_local"
    | "wallet_short"
    | "fallback"
}

export function shortAddress(addr: string | null | undefined): string | null {
  if (!addr) return null
  const trimmed = addr.trim()
  if (trimmed.length < 10) return trimmed || null
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`
}

function pickIfClean(
  candidate: string | null | undefined,
  source: ResolvedDisplayName["source"]
): ResolvedDisplayName | null {
  if (!candidate) return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  if (isBlocklisted(trimmed)) return null
  return { display_name: trimmed, source }
}

export async function resolveDisplayName(opts: {
  user_id: string
  email?: string | null
  wallet_addr?: string | null
}): Promise<ResolvedDisplayName> {
  const { user_id } = opts

  // Step 1+2: read user_profiles + profile_bio in parallel.
  const [up, pb, al] = await Promise.all([
    (supabaseAdmin as any)
      .from("user_profiles")
      .select("display_name, wallet_address")
      .eq("id", user_id)
      .maybeSingle(),
    (supabaseAdmin as any)
      .from("profile_bio")
      .select("display_name")
      .eq("user_id", user_id)
      .maybeSingle(),
    opts.email
      ? (supabaseAdmin as any)
          .from("allow_list")
          .select("username, wallet_addr")
          .ilike("email", opts.email)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const fromUserProfiles = pickIfClean(up?.data?.display_name, "user_profiles")
  if (fromUserProfiles) return fromUserProfiles

  const fromProfileBio = pickIfClean(pb?.data?.display_name, "profile_bio")
  if (fromProfileBio) return fromProfileBio

  const fromAllowList = pickIfClean(al?.data?.username, "allow_list_username")
  if (fromAllowList) return fromAllowList

  const emailLocal = opts.email ? opts.email.split("@")[0] : null
  const fromEmail = pickIfClean(emailLocal, "email_local")
  if (fromEmail) return fromEmail

  const walletAddr =
    opts.wallet_addr ??
    (al?.data?.wallet_addr as string | null | undefined) ??
    (up?.data?.wallet_address as string | null | undefined) ??
    null
  const short = shortAddress(walletAddr)
  if (short) {
    return { display_name: short, source: "wallet_short" }
  }

  return { display_name: "Collector", source: "fallback" }
}
