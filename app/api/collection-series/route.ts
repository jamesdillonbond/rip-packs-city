import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollection } from "@/lib/collections"

/**
 * GET /api/collection-series?collection=nfl-all-day
 *
 * Returns the series entries for a given collection from collection_series table.
 * Used by the collection page to populate the series filter dropdown dynamically.
 */
export async function GET(req: NextRequest) {
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot"
  const collectionObj = getCollection(collectionSlug)
  if (!collectionObj) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 })
  }

  // Look up collection UUID from collection_config using flow_contract_name
  const contractName = collectionObj.flowContractName
  if (!contractName) {
    return NextResponse.json({ series: [] })
  }

  const { data: config } = await (supabaseAdmin as any)
    .from("collection_config")
    .select("collection_id")
    .eq("flow_contract_name", contractName)
    .single()

  if (!config?.collection_id) {
    return NextResponse.json({ series: [] })
  }

  const { data: series } = await (supabaseAdmin as any)
    .from("collection_series")
    .select("series_number, display_label, season")
    .eq("collection_id", config.collection_id)
    .order("series_number", { ascending: true })

  return NextResponse.json({ series: series ?? [] })
}
