// app/api/wallet-backfill-candy/route.ts
//
// Item 5 — Candy (Solana) wallet enricher. Reads a wallet's Metaplex Core
// holdings via DAS getAssetsByOwner, filters to the Candy collection, and
// upserts wallet_moments_cache rows (same serial shape as the editions ingest).
// This is what makes a pasted Candy wallet resolve once the per-surface address
// validators flip (readiness GAP 1).
//
// INERT until discovery: short-circuits to a clean no-op until
// CANDY_MLB_COLLECTION_ADDRESS is filled (Item 0). ?force=true is accepted for
// parity with the Flow backfills (it has no filtering effect here — every
// on-chain row is written every run).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { paginateOwner, type DasAsset } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_COLLECTION_ADDRESS,
  CANDY_MLB_SLUG,
  candyDiscoveryReady,
  normalizeSerial,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "wallet-backfill-candy"
const UPSERT_CHUNK = 500

// Permissive base58 sanity check — keeps obvious garbage off DAS without
// pinning the exact Solana address shape (the strict per-chain validator flips
// at launch, GAP 1).
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function inCandyCollection(asset: DasAsset): boolean {
  return (asset.grouping ?? []).some(
    (g) => g.group_key === "collection" && g.group_value === CANDY_MLB_COLLECTION_ADDRESS
  )
}

async function logRun(
  startedAtIso: string,
  wallet: string,
  rowsFound: number,
  rowsWritten: number,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet, ...extra },
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string; force?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const url = new URL(req.url)
  const force = body.force === true || url.searchParams.get("force") === "true"
  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
  // base58, case-sensitive (memory: chain-aware-address-foundation) — do NOT
  // lowercase a Solana address.
  if (!BASE58_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet is not a base58 Solana address" }, { status: 400 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  if (!candyDiscoveryReady()) {
    await logRun(startedAtIso, wallet, 0, 0, true, null, { skip_reason: "discovery_pending" })
    return NextResponse.json(
      { accepted: false, skipped: "discovery_pending", collection: CANDY_MLB_SLUG, wallet_address: wallet },
      { status: 202 }
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    try {
      await paginateOwner(wallet, async (items) => {
        const now = new Date().toISOString()
        const rows = (items as DasAsset[])
          .filter(inCandyCollection)
          .map((a) => {
            const s = normalizeSerial(a)
            if (!s.moment_id) return null
            // Trust DAS ownership, but stamp the queried wallet so a stale
            // owner field can't misattribute the row.
            return { ...s, wallet_address: wallet, last_seen_at: now }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
        found += rows.length
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
          const chunk = rows.slice(i, i + UPSERT_CHUNK)
          const { data, error } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
            .select("moment_id")
          if (error) {
            console.log(`[${PIPELINE_NAME}] wmc upsert err: ${error.message}`)
          } else {
            written += data?.length ?? chunk.length
          }
        }
      })

      await logRun(startedAtIso, wallet, found, written, true, null, {
        force,
        rows_found: found,
        rows_written: written,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, wallet, found, written, false, e instanceof Error ? e.message : String(e), {
        force,
        rows_found: found,
        rows_written: written,
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, wallet_address: wallet, force, started_at: startedAtIso },
    { status: 202 }
  )
}
