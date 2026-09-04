// app/api/cost-basis/route.ts
//
// GET /api/cost-basis?wallet=0x...&collection=nfl-all-day
// Returns per-moment cost basis for a wallet via get_wallet_cost_basis() RPC.
// Bypasses PostgREST 1000-row cap.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { createClient } from "@supabase/supabase-js"
import { getCollection } from "@/lib/collections"

/**
 * Resolve a collection slug to its id.
 *
 * ⚠ RETURNS A DISCRIMINATED RESULT BECAUSE `null` MEANT TWO OPPOSITE THINGS.
 * This used to return `string | null`, and the caller reads a null as "no
 * collection filter was asked for" — `if (collectionId) rpcParams.p_collection_id = …`.
 * But a FAILED `collection_config` read also produced null, and the failure mode
 * that creates is not an empty answer: the cost-basis RPC then runs UNSCOPED and
 * returns every collection the wallet holds, rendered inside a single-collection
 * tab. **A different question, answered silently, about the reader's own money.**
 *
 * On the live path the two cases are not even close: CollectionTabClient always
 * sends `&collection=<slug>` taken from the route param, so `slug` is non-null and
 * `getCollection` resolves — which means a null from here can ONLY be the failed
 * read. `ok: false` now makes the caller say so instead of widening the scope.
 */
async function resolveCollectionId(
  supabase: any,
  slug: string | null,
): Promise<{ id: string | null; ok: boolean; error?: unknown }> {
  if (!slug) return { id: null, ok: true }
  const collectionObj = getCollection(slug)
  const contractName = collectionObj?.flowContractName
  if (!contractName) return { id: null, ok: true }
  const { data, error } = await boundedRead(supabase
    .from("collection_config")
    .select("collection_id")
    .eq("flow_contract_name", contractName)
    .single(), "api/cost-basis/collection_config")
  if (error) return { id: null, ok: false, error }
  return { id: data?.collection_id ?? null, ok: true }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const normalized = wallet.startsWith("0x") ? wallet : "0x" + wallet
  const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || null
  const resolved = await resolveCollectionId(supabase as any, collectionSlug)
  if (!resolved.ok) {
    // Widening the scope is strictly worse than returning nothing here: the caller
    // would render another collection's cost basis as this one's.
    return apiErrorResponse(resolved.error, "api/cost-basis")
  }
  const collectionId = resolved.id

  const rpcParams: Record<string, any> = { p_wallet: normalized }
  if (collectionId) rpcParams.p_collection_id = collectionId

  const { data, error } = await boundedRead((supabase as any).rpc("get_wallet_cost_basis", rpcParams), "api/cost-basis/get_wallet_cost_basis")

  // Enrich with acquisition_method from moment_acquisitions
  if (data && Array.isArray(data)) {
    const nftIds = data.map((r: any) => r.nft_id).filter(Boolean)
    if (nftIds.length > 0) {
      // Deliberately NOT fatal, and the difference from the resolve above is the
      // point: a missing acquisition_method renders NOTHING in SlabFooter (its
      // "PACK PULL"/"MINTED" chip is gated on the value being present), so a failed
      // read here degrades a field without making a false claim. It was silent
      // though — logging is what was missing, not a status code.
      const { data: acqData, error: acqErr } = await boundedRead((supabase as any).rpc("get_wallet_acquisition_data", {
        p_wallet: normalized,
        p_moment_ids: nftIds,
      }), "api/cost-basis/get_wallet_acquisition_data")
      if (acqErr) console.error("[api/cost-basis] acquisition enrich:", acqErr.message)
      if (acqData) {
        const acqMap = new Map<string, string>()
        for (const row of acqData) {
          if (!acqMap.has(row.moment_id)) acqMap.set(row.moment_id, row.acquisition_method)
        }
        for (const item of data) {
          item.acquisition_method = acqMap.get(item.nft_id) ?? null
        }
      }
    }
  }
  if (error) {
    return apiErrorResponse(error, "api/cost-basis");
  }

  return NextResponse.json(
    { acquisitions: data ?? [] },
    { headers: { "Cache-Control": "private, max-age=60" } }
  )
}
