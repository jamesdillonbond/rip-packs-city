// app/api/portfolio-export/route.ts
// CSV export of a wallet's full portfolio for a given collection.
// GET /api/portfolio-export?wallet=0x...&collection=slug

import { NextRequest, NextResponse } from "next/server"
import { normalizeAddress } from "@/lib/address"
import { getCollection } from "@/lib/collections"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"

// ⛔ 2026-09-19 — THIS WAS A HARDCODED FOUR-COLLECTION MAP, and it is the
// second defect in this route: the Export CSV control renders on every
// Collection tab, but the map omitted UFC (published since before this route
// existed) and Candy MLB (Collection tab shipped earlier today), so both
// answered 400 "Unknown collection" from a button the reader can see. A
// hardcoded allowlist beside a registry is a copy that goes stale silently —
// the registry is the single source of truth for which collections exist.
//
// ⚠ Gated on `published` AND on the collection actually HAVING a Collection
// tab, so the route's surface is exactly the set of buttons that can call it:
// widening to the whole registry would expose unpublished collections (Panini,
// RWA) through an endpoint no UI offers for them.

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export async function GET(req: NextRequest) {
  // ⛔ 2026-09-19 — was `.trim().toLowerCase()`, and this route is reached by
  // the "Export CSV" control on the Collection tab, which SHIPPED FOR CANDY
  // EARLIER TODAY. `get_wallet_moments_with_fmv` does not fold its wallet (its
  // only `lower()` calls are on player_name and tier), so the fold here was the
  // whole defect. Measured live on a real Candy wallet: correct key → 1,726
  // moments; lowercased → 0. The reader would have been handed an EMPTY CSV
  // — and the filename carried the mangled address, so even the artifact on
  // their disk was wrong. `normalizeAddress` folds hex exactly as before.
  const wallet = normalizeAddress(req.nextUrl.searchParams.get("wallet")?.trim() ?? "")
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot"
  if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  const collection = getCollection(collectionSlug)
  const collectionId =
    collection?.published && collection.pages.includes("collection")
      ? collection.supabaseCollectionId ?? null
      : null
  if (!collectionId) return NextResponse.json({ error: "Unknown collection" }, { status: 400 })

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
      p_wallet: wallet,
      p_sort_by: "fmv_desc",
      p_limit: 99999,
      p_offset: 0,
      p_collection_id: collectionId,
    }), "api/portfolio-export/get_wallet_moments_with_fmv")
    if (error) return apiErrorResponse(error, "api/portfolio-export");const moments: any[] = (data?.moments ?? []) as any[]

    const headers = [
      "Player", "Set", "Series", "Tier", "Serial", "Circulation",
      "FMV", "Low Ask", "Acquisition Method", "Buy Price",
      "Is Locked", "Acquired At",
    ]
    const lines = [headers.join(",")]
    for (const m of moments) {
      lines.push([
        csvCell(m.player_name),
        csvCell(m.set_name),
        csvCell(m.series_number),
        csvCell(m.tier),
        csvCell(m.serial_number),
        csvCell(m.circulation_count),
        csvCell(m.fmv_usd != null ? Number(m.fmv_usd).toFixed(2) : ""),
        csvCell(m.low_ask != null ? Number(m.low_ask).toFixed(2) : ""),
        csvCell(m.acquisition_method),
        csvCell(m.buy_price != null ? Number(m.buy_price).toFixed(2) : ""),
        // ⛔ Three states, not two. This cell used to be
        // `m.is_locked ? "true" : "false"`, so a moment nobody ever checked
        // was exported as a definite "false" into a file the user keeps and
        // may act on. 1,160,468 of 1,767,936 Top Shot rows are in exactly
        // that state (register #112). `unknown` is a third value in a column
        // that already carries strings, so a parser that split on true/false
        // sees a new token rather than a silently wrong one.
        csvCell(m.lock_known === true ? (m.is_locked ? "true" : "false") : "unknown"),
        csvCell(m.acquired_at ?? ""),
      ].join(","))
    }
    const csv = lines.join("\n")
    const date = new Date().toISOString().slice(0, 10)
    const filename = `rpc-portfolio-${wallet}-${collectionSlug}-${date}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/portfolio-export");
  }
}
