import { NextRequest, NextResponse } from "next/server"
import {safeApiError, isUnresolvedIdentifierError, unresolvedIdentifierResponse} from "@/lib/api-error";
import { resolveToFlowAddress } from "@/lib/chains/flow/flow-resolve"
import { packNftTypeName } from "@/lib/packs/live-pack-listings"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollection } from "@/lib/collections"
import { ownLookup } from "@/lib/safe-lookup"
import { boundedRead } from "@/lib/api/bounded-read"

// 2026-11-18 (#218): Studio GraphQL (searchPackNftAggregation) has answered HTTP 530 since 11-17.
// Sealed counts now come from Atlas PackService/GetPackCountsByOwnerGroupedByDistribution, one call per
// wallet + product. Vercel's egress is firewalled by Atlas (measured 06-16), so the call goes through
// pg_net: atlas_wallet_pack_counts_begin + the shared atlas_await_response. Titles come from our own
// pack_distributions (Atlas counts carry ids only); a dist we hold no title for counts in `owned`
// and `totalSealedPacks` but not in `packsByTitle`, exactly as an untitled Studio node did.
const ATLAS_PRODUCT: Record<string, "nba" | "nfl" | "laliga"> = {
  "nba-top-shot": "nba",
  "nfl-all-day": "nfl",
  "laliga-golazos": "laliga",
}

type PackCount = { distributionId?: string; sealedCount?: string | number }

/** One Atlas read through pg_net; a Cloudflare challenge (403/429) is retried once. Throws on failure. */
async function atlasSealedCounts(wallet: string, product: "nba" | "nfl" | "laliga"): Promise<PackCount[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let lastStatus: string = "no response"
  for (let attempt = 1; attempt <= 2; attempt++) {
    const begin = await boundedRead(db.rpc("atlas_wallet_pack_counts_begin", { p_wallet: wallet, p_product: product }), "wallet-packs/atlas-begin", 5_000)
    if (begin.error) throw new Error(`wallet packs begin: ${begin.error.message ?? "failed"}`)
    const id = Number(begin.data)
    if (!Number.isFinite(id) || id <= 0) throw new Error("wallet packs begin returned no request id")
    // The await polls server-side for up to 8 s; the client bound sits just above it.
    const col = await boundedRead(db.rpc("atlas_await_response", { p_request_id: id, p_max_ms: 8000 }), "wallet-packs/atlas-await", 12_000)
    if (col.error) throw new Error(`wallet packs await: ${col.error.message ?? "failed"}`)
    const env = col.data as { ok?: boolean; body?: { distributionPackCounts?: unknown }; status?: number | null } | null
    if (env?.ok === true) {
      const arr = env.body?.distributionPackCounts
      // An answer without the array is not "holds nothing" (CLAUDE.md honesty canon).
      if (!Array.isArray(arr)) throw new Error("wallet packs response carried no distributionPackCounts")
      return arr as PackCount[]
    }
    lastStatus = env?.status != null ? `HTTP ${env.status}` : "no response"
    if (!(env?.status === 403 || env?.status === 429)) break
  }
  throw new Error(`wallet packs ${lastStatus}`)
}

// 2026-09-29: usernames resolve through the shared ladder (cache → live Atlas →
// Top Shot GQL). The local copy went cache → the dead Top Shot host only, so a
// username not already cached could never resolve here.
const resolveWallet = resolveToFlowAddress

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const input = searchParams.get("wallet")?.trim()
    if (!input) return NextResponse.json({ error: "wallet param required" }, { status: 400 })

    // ⛔ SUBSTITUTION (2026-10-19). The PackNFT type was hardcoded to Top Shot's,
    // and the Collection tab called this on EVERY collection, matching an All Day
    // or Golazos set name against the wallet's Top Shot pack titles. The read is
    // now scoped to the collection asked about; one this lane cannot read is
    // refused, never answered with another collection's packs. An ABSENT param
    // keeps the historical Top Shot default.
    const collection = searchParams.get("collection")?.trim() || "nba-top-shot"
    const typeName = packNftTypeName(collection)
    if (!typeName) {
      return NextResponse.json(
        { error: "Sealed pack holdings are not available for this collection." },
        { status: 400 },
      )
    }

    const walletAddress = await resolveWallet(input)

    const product = ownLookup(ATLAS_PRODUCT, collection)
    const collectionId = getCollection(collection)?.supabaseCollectionId
    if (!product || !collectionId) {
      return NextResponse.json(
        { error: "Sealed pack holdings are not available for this collection." },
        { status: 400 },
      )
    }

    const counts = await atlasSealedCounts(walletAddress.toLowerCase(), product)
    const owned: Record<string, number> = {}
    let totalSealed = 0
    for (const c of counts) {
      const distId = c.distributionId != null ? String(c.distributionId) : ""
      const n = Number(c.sealedCount)
      if (!distId || !Number.isFinite(n) || n <= 0) continue
      owned[distId] = (owned[distId] ?? 0) + n
      totalSealed += n
    }

    // Titles for client-side matching, from our catalog. A failed read fails the request rather than
    // returning counts the UI cannot match to a pack (the matcher reads packsByTitle).
    const packsByTitle: Record<string, number> = {}
    const distIds = Object.keys(owned)
    if (distIds.length > 0) {
      const { data: rows, error: tErr } = await boundedRead(
        (supabaseAdmin as any)
          .from("pack_distributions")
          .select("dist_id, title")
          .eq("collection_id", collectionId)
          .in("dist_id", distIds.slice(0, 1000)),
        "wallet-packs/titles",
      )
      if (tErr) throw new Error(`pack_distributions read: ${tErr.message}`)
      for (const r of (rows ?? []) as Array<{ dist_id: string; title: string | null }>) {
        if (r.title) packsByTitle[r.title] = (packsByTitle[r.title] ?? 0) + (owned[String(r.dist_id)] ?? 0)
      }
    }

    return NextResponse.json({
      walletAddress,
      collection,
      totalSealedPacks: totalSealed,
      owned,
      packsByTitle,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "wallet-packs failed"

    // Username resolution failures and similar client errors → 400. Reading the
    // message SERVER-SIDE to classify is fine; what is published is fixed copy,
    // since `message` here is whatever the resolver threw.
    if (isUnresolvedIdentifierError(e)) return unresolvedIdentifierResponse()

    // Atlas / network failures → return empty result instead of 500. That
    // degradation is deliberate (the caller reads packsByTitle and renders
    // nothing), but the `error` key must not carry the upstream's own text.
    console.error("[wallet-packs] error:", message)
    return NextResponse.json({
      walletAddress: null,
      totalSealedPacks: 0,
      owned: {},
      packsByTitle: {},
      error: safeApiError(e, "Sealed pack data is unavailable right now.").error,
    })
  }
}