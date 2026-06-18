// app/api/profile/collection-breakdown/route.ts
//
// GET /api/profile/collection-breakdown[?ownerKey=username]
// Merges per-collection moment_count + total_fmv across the saved wallets of
// a target user. With ?ownerKey=username (the public path used by the profile
// page) the user is resolved through profile_bio — holdings are PUBLIC on a
// collector showcase, so this path is unauthenticated. Without ownerKey it
// falls back to the current authenticated user (dashboard own-view).
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to read the
// wallet list — bypasses the JWT-forwarding gap that was making the
// post-R3 endpoints return empty.
//
// Failure modes return { collections: [] } with a meta hint.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

// Resolve a public ownerKey (username) → user_id the same way the other
// public ownerKey-driven profile endpoints (teams, portfolio-history) do.
async function resolveUserId(ownerKey: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle()
  if (error) {
    console.log("[collection-breakdown] resolveUserId failed:", error.message)
    return null
  }
  return (data as any)?.user_id ?? null
}

// Collection color palette. Keyed by collections.slug, which is the
// UNDERSCORED vocabulary (nba_top_shot, nfl_all_day, …) — slugMap below is
// built from collections.slug, so these keys must match it exactly or every
// card falls through to DEFAULT_COLOR.
const COLLECTION_COLOR: Record<string, string> = {
  nba_top_shot: "#E03A2F",
  nfl_all_day: "#10B981",
  laliga_golazos: "#FBBF24",
  disney_pinnacle: "#8B5CF6",
  ufc_strike: "#F59E0B",
}
const DEFAULT_COLOR = "#6B7280"

type Row = {
  collection_id: string | null
  collection_name: string | null
  moment_count: number
  total_fmv: number | string | null
}

interface SavedWallet {
  wallet_addr: string | null
  username: string | null
  collection_id: string | null
  collection_slug: string | null
  nickname: string | null
  cached_fmv_usd: number | null
}

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ collections: [], ...(meta ? { meta } : {}) })
}

export async function GET(req: NextRequest) {
  // Public ownerKey path (profile page) vs authenticated own-view fallback.
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim()
  let userId: string | null = null
  if (ownerKey) {
    userId = await resolveUserId(ownerKey)
    if (!userId) {
      return emptyResponse({ owner_not_found: true })
    }
  } else {
    const user = await getCurrentUser()
    if (!user) {
      return emptyResponse({ unauthenticated: true })
    }
    userId = user.id
  }

  try {
    const { data: walletsRaw, error: walletsError } = await (supabase as any).rpc(
      "get_user_saved_wallets",
      { p_user_id: userId }
    )

    if (walletsError) {
      console.log(
        "[collection-breakdown] get_user_saved_wallets failed:",
        walletsError.message,
        "code:",
        (walletsError as { code?: string }).code ?? "unknown"
      )
      return emptyResponse({ saved_wallets_unavailable: true })
    }

    const wallets = (walletsRaw ?? []) as SavedWallet[]
    if (wallets.length === 0) {
      return emptyResponse({ no_wallets: true })
    }

    // get_user_saved_wallets returns one row per (wallet x published
    // collection), so the same wallet appears once per collection. Dedupe
    // the address list — get_collection_breakdown already returns every
    // collection for a given wallet, so calling it once per distinct wallet
    // is correct. Without this the merge sums each wallet's data ~Nx (one
    // per collection-row), which inflated moment_count + total_fmv ~4x.
    const addrs = Array.from(
      new Set(
        wallets
          .map((w) => w.wallet_addr)
          .filter((a): a is string => typeof a === "string" && a.length > 0)
      )
    )

    const merged = new Map<
      string,
      { collection_id: string; collection_name: string; moment_count: number; total_fmv: number }
    >()

    for (const addr of addrs) {
      const { data, error } = await (supabase as any).rpc("get_collection_breakdown", {
        p_wallet: addr,
      })
      if (error) {
        console.log(
          "[collection-breakdown] get_collection_breakdown failed for",
          addr,
          "message:",
          error.message,
          "code:",
          error.code ?? "unknown"
        )
        continue
      }
      const rows: Row[] = Array.isArray(data) ? (data as Row[]) : []
      for (const r of rows) {
        const id = r.collection_id ?? "unknown"
        const existing = merged.get(id)
        const fmv = Number(r.total_fmv ?? 0)
        if (existing) {
          existing.moment_count += Number(r.moment_count ?? 0)
          existing.total_fmv += Number.isFinite(fmv) ? fmv : 0
        } else {
          merged.set(id, {
            collection_id: id,
            collection_name: r.collection_name ?? "Unknown",
            moment_count: Number(r.moment_count ?? 0),
            total_fmv: Number.isFinite(fmv) ? fmv : 0,
          })
        }
      }
    }

    // Look up slugs so we can color-code by slug.
    const ids = Array.from(merged.keys()).filter((id) => id !== "unknown")
    const slugMap = new Map<string, string>()
    if (ids.length > 0) {
      const { data: cols } = await (supabase as any)
        .from("collections")
        .select("id, slug")
        .in("id", ids)
      for (const c of (cols ?? []) as Array<{ id: string; slug: string }>) {
        if (c.id && c.slug) slugMap.set(c.id, c.slug)
      }
    }

    const collections = Array.from(merged.values())
      .map((c) => ({
        ...c,
        color: COLLECTION_COLOR[slugMap.get(c.collection_id) ?? ""] ?? DEFAULT_COLOR,
      }))
      .sort((a, b) => b.total_fmv - a.total_fmv || b.moment_count - a.moment_count)

    return NextResponse.json({ collections })
  } catch (err: any) {
    console.log(
      "[collection-breakdown] unexpected:",
      err?.message ?? String(err),
      "code:",
      err?.code ?? "unknown"
    )
    return emptyResponse({ unexpected_error: true })
  }
}
