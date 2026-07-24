import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Aggregates the Disney Pinnacle wallet view: moments + totals + variant
// breakdown + franchise breakdown. Fronts the shared RPCs so the client
// only has to make a single call.

const PINNACLE_COLLECTION_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase() ?? ""
  if (!wallet.startsWith("0x")) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }

  try {
    const [momentsRes, totalRes, variantsRes, franchisesRes, bestOfferRes] = await Promise.all([
      (supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
        p_wallet: wallet,
        p_collection_id: PINNACLE_COLLECTION_UUID,
        p_limit: 500,
        p_offset: 0,
      }),
      (supabaseAdmin as any).rpc("get_pinnacle_wallet_total_fmv", { p_wallet: wallet }),
      (supabaseAdmin as any).rpc("get_pinnacle_variant_breakdown", { p_wallet: wallet }),
      (supabaseAdmin as any).rpc("get_pinnacle_franchise_breakdown", { p_wallet: wallet }),
      (supabaseAdmin as any).rpc("get_pinnacle_wallet_best_offer_total", { p_wallet: wallet }),
    ])

    const momentsJson = momentsRes?.data ?? {}
    const moments = Array.isArray(momentsJson) ? momentsJson
      : Array.isArray(momentsJson?.moments) ? momentsJson.moments
      : Array.isArray(momentsJson?.data) ? momentsJson.data
      : []

    const totalJson = totalRes?.data ?? {}
    const totalFmv = typeof totalJson === "number" ? totalJson
      : typeof totalJson?.total_fmv === "number" ? totalJson.total_fmv
      : typeof totalJson?.fmv_total === "number" ? totalJson.fmv_total
      : null
    const momentCount = typeof totalJson?.moment_count === "number" ? totalJson.moment_count
      : typeof totalJson?.count === "number" ? totalJson.count
      : moments.length

    // get_pinnacle_variant_breakdown returns [{ variant: "<UPPERCASE TIER>", count, total_fmv }]
    // — the variant analogue of get_pinnacle_franchise_breakdown. The wallet page
    // expects { variant_type, count, total_fmv } and keys its colour/rank maps by
    // Title-Case names, so normalise the casing here. total_fmv now carries the real
    // per-variant FMV sum (grouped identically to the old counts RPC, so counts are
    // unchanged) instead of a hardcoded null — matching the franchise chips, which
    // already show it.
    const toTitleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    const variantsRaw = Array.isArray(variantsRes?.data) ? variantsRes.data : []
    const variants = variantsRaw.map((v: any) => ({
      variant_type: toTitleCase(String(v?.variant ?? "")),
      count: Number(v?.count) || 0,
      total_fmv: v?.total_fmv != null ? Number(v.total_fmv) : null,
    }))

    // get_pinnacle_franchise_breakdown returns [{ franchise, pin_count, total_fmv }];
    // the wallet page's FranchiseBucket expects `count`, not `pin_count`.
    const franchisesRaw = Array.isArray(franchisesRes?.data) ? franchisesRes.data : []
    const franchises = franchisesRaw.map((f: any) => ({
      franchise: f?.franchise ?? "Unknown",
      count: Number(f?.pin_count ?? f?.count) || 0,
      total_fmv: f?.total_fmv ?? null,
    }))

    // Pinnacle has no locking concept — every pin in wallet_moments_cache
    // for collection 7dd9dd11... has is_locked = false. Return null (not 0)
    // for lockedFmv + lockedCount so <WalletStatRow> renders em-dash with
    // an "n/a for this collection" caption rather than a misleading
    // "0 locked" caption.
    //
    // bestOfferTotal: sum of the best standing DapperOffersV2 bid per held pin,
    // via get_pinnacle_wallet_best_offer_total (marketplace_offers, DUC ~= USD).
    // No Pinnacle offer ingest exists yet, so this reads 0 today — we surface
    // null (not 0) to keep the tile honest, and it lights up automatically once
    // Pinnacle offers land in marketplace_offers. spreadGap = FMV − best offer.
    const bestOfferRaw = typeof bestOfferRes?.data === "number"
      ? bestOfferRes.data
      : Number(bestOfferRes?.data)
    const unlockedFmv = totalFmv
    const unlockedCount = momentCount
    const lockedFmv: number | null = null
    const lockedCount: number | null = null
    const bestOfferTotal: number | null =
      Number.isFinite(bestOfferRaw) && bestOfferRaw > 0 ? bestOfferRaw : null
    const spreadGap: number | null =
      totalFmv !== null && bestOfferTotal !== null ? totalFmv - bestOfferTotal : null

    return NextResponse.json({
      ok: true,
      wallet,
      moments,
      momentCount,
      totalFmv,
      unlockedFmv,
      unlockedCount,
      lockedFmv,
      lockedCount,
      bestOfferTotal,
      spreadGap,
      variants,
      franchises,
      errors: {
        moments: momentsRes?.error?.message ?? null,
        total: totalRes?.error?.message ?? null,
        variants: variantsRes?.error?.message ?? null,
        franchises: franchisesRes?.error?.message ?? null,
        bestOffer: bestOfferRes?.error?.message ?? null,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
