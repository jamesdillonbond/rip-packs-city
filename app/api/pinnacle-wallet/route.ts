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
    const [momentsRes, totalRes, variantsRes, franchisesRes] = await Promise.all([
      (supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
        p_wallet: wallet,
        p_collection_id: PINNACLE_COLLECTION_UUID,
        p_limit: 500,
        p_offset: 0,
      }),
      (supabaseAdmin as any).rpc("get_pinnacle_wallet_total_fmv", { p_wallet: wallet }),
      (supabaseAdmin as any).rpc("get_pinnacle_variant_counts", { p_wallet: wallet }),
      (supabaseAdmin as any).rpc("get_pinnacle_franchise_breakdown", { p_wallet: wallet }),
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

    const variants = Array.isArray(variantsRes?.data) ? variantsRes.data
      : Array.isArray(variantsRes?.data?.variants) ? variantsRes.data.variants : []
    const franchises = Array.isArray(franchisesRes?.data) ? franchisesRes.data
      : Array.isArray(franchisesRes?.data?.franchises) ? franchisesRes.data.franchises : []

    return NextResponse.json({
      ok: true,
      wallet,
      moments,
      momentCount,
      totalFmv,
      variants,
      franchises,
      errors: {
        moments: momentsRes?.error?.message ?? null,
        total: totalRes?.error?.message ?? null,
        variants: variantsRes?.error?.message ?? null,
        franchises: franchisesRes?.error?.message ?? null,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}
