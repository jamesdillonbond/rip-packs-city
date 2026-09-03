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
// ⚠ FAILURE MODES USED TO RETURN `{ collections: [] }` AT HTTP 200 WITH A META
// HINT, AND THAT DEFEATED THE CLIENT THAT WAS WRITTEN TO CATCH THEM.
// `CollectionBreakdownCard` reads the response through `fetchJson` and
// discriminates on `res.ok` — an HTTP-level test that a route which always
// answers 200 can never fail. Nothing anywhere reads `meta`. So every one of
// those "handled" failures rendered "No collection data yet." beside a moment
// count of 0 to a collector who owns thousands, which is exactly the copy the
// component's own comment says was fixed. Two layers each looked right and the
// pair published the claim.
//
// Now: a genuine READ FAILURE (owner lookup, saved-wallets RPC, an unexpected
// throw, or a per-wallet breakdown that would silently understate the total)
// answers with `apiErrorResponse`, which the card already renders as
// "Couldn't load your collection breakdown right now." The genuinely-empty
// states — no such owner, unauthenticated, no saved wallets — keep their honest
// 200 and their meta hint.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { apiErrorResponse } from "@/lib/api-error"

// Resolve a public ownerKey (username) → user_id the same way the other
// public ownerKey-driven profile endpoints (teams, portfolio-history) do.
type OwnerResolution =
  | { ok: true; userId: string | null }
  | { ok: false; error: unknown }

async function resolveUserId(ownerKey: string): Promise<OwnerResolution> {
  const { data, error } = await (supabase as any)
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle()
  if (error) {
    console.log("[collection-breakdown] resolveUserId failed:", error.message)
    // ⚠ This used to `return null`, which the caller spells
    // `owner_not_found: true` — a claim that the collector does not exist,
    // manufactured from a database timeout. Logging an error is not reporting
    // it; the caller still could not tell the two apart.
    return { ok: false, error }
  }
  return { ok: true, userId: (data as any)?.user_id ?? null }
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
  // Appended by migration 20260903142035: the STALE-confidence slice of
  // total_fmv, read through editions → edition_fmv_current. The card shows
  // total − stale with the stale part as a caption, exactly like the profile
  // headline — before this the breakdown rows summed to ~2× the headline on
  // the same page (re-QA 2026-09-03).
  stale_fmv?: number | string | null
  stale_count?: number | string | null
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
    const owner = await resolveUserId(ownerKey)
    if (!owner.ok) {
      return apiErrorResponse(owner.error, "api/profile/collection-breakdown")
    }
    userId = owner.userId
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
      return apiErrorResponse(walletsError, "api/profile/collection-breakdown")
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
      { collection_id: string; collection_name: string; moment_count: number; total_fmv: number; stale_fmv: number; stale_count: number }
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
        // ⚠ This used to `continue`, which is the PARTIAL-READ shape CLAUDE.md
        // names: the loop drops one wallet's holdings and publishes the sum of
        // the rest as if it were the whole. A collector with three saved
        // wallets, one of which timed out, saw an understated moment count and
        // FMV total FOR THEIR OWN MONEY, with nothing in the response marking
        // it partial. The canon's two options are "throw, or carry
        // complete:false" — and `complete:false` is not available here, because
        // the only consumer discriminates on HTTP ok and reads no meta at all.
        // ⚠ TRADE-OFF, stated: under the standing IO-saturation band this will
        // surface the card's error state where it previously showed a quietly
        // wrong number. That is the intended direction — a wrong total about
        // the reader's own holdings is the worse of the two.
        return apiErrorResponse(error, "api/profile/collection-breakdown")
      }
      const rows: Row[] = Array.isArray(data) ? (data as Row[]) : []
      for (const r of rows) {
        const id = r.collection_id ?? "unknown"
        const existing = merged.get(id)
        const fmv = Number(r.total_fmv ?? 0)
        const stale = Number(r.stale_fmv ?? 0)
        const staleCount = Number(r.stale_count ?? 0)
        if (existing) {
          existing.moment_count += Number(r.moment_count ?? 0)
          existing.total_fmv += Number.isFinite(fmv) ? fmv : 0
          existing.stale_fmv += Number.isFinite(stale) ? stale : 0
          existing.stale_count += Number.isFinite(staleCount) ? staleCount : 0
        } else {
          merged.set(id, {
            collection_id: id,
            collection_name: r.collection_name ?? "Unknown",
            moment_count: Number(r.moment_count ?? 0),
            total_fmv: Number.isFinite(fmv) ? fmv : 0,
            stale_fmv: Number.isFinite(stale) ? stale : 0,
            stale_count: Number.isFinite(staleCount) ? staleCount : 0,
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
    return apiErrorResponse(err, "api/profile/collection-breakdown")
  }
}
