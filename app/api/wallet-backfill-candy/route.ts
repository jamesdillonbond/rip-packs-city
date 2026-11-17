// app/api/wallet-backfill-candy/route.ts
//
// Item 5 — Candy (Solana) wallet enricher, fired when a signed-in user SAVES a Candy wallet
// (lib/profile/warm-wallet.ts). Since 2026-11-08 it is a thin wrapper over
// lib/candy/refresh-wallet.ts — the same walk the anonymous /api/candy/wallet-refresh runs
// when an address is pasted — so the two can no longer drift. Before, this route carried its
// own copy of the owner walk, which read only the five registry sets, inserted no editions,
// never retired a card the wallet had sold, and never counted the wallet's untracked Candy
// collectibles; the shared walk does all four, and retires ONLY behind a complete walk (a
// failed DAS page, listings read or write retires nothing).
//
// INERT until discovery: short-circuits to a clean no-op until the Candy collection address
// is filled (Item 0). ?force=true is accepted for parity with the Flow backfills (it has no
// filtering effect here — every on-chain row is written every run).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { CANDY_MLB_SLUG, candyDiscoveryReady } from "@/lib/chains/solana/normalize"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { refreshCandyWallet } from "@/lib/candy/refresh-wallet"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "wallet-backfill-candy"
// The walk stops itself (reported incomplete, nothing retired) well inside maxDuration: a
// maxDuration kill writes no run row at all.
const WALK_BUDGET_MS = 240_000

// Permissive base58 sanity check — keeps obvious garbage off DAS. base58 is CASE-SENSITIVE:
// a Solana address is never lowercased or 0x-prefixed (CLAUDE.md, "Chain two").
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

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
  if (!expectedToken || !bearerMatches(authHeader, "INGEST_SECRET_TOKEN")) {
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
    try {
      const r = await refreshCandyWallet(supabaseAdmin, wallet, { retire: true, deadlineAt: startedMs + WALK_BUDGET_MS })
      // ok is DERIVED from the walk: every page read, every listed card read, every write
      // landed (R123 — a rejected write is not a success).
      const error = r.write_errors.length
        ? `${r.write_errors.length} rejected write(s): ${r.write_errors.slice(0, 3).join(" | ")}`
        : r.walk_error
          ? `walk incomplete: ${r.walk_error}`
          : r.escrow_listed_error
            ? `escrow-listed read failed: ${r.escrow_listed_error}`
            : r.retire_error
              ? `retire failed: ${r.retire_error}`
              : null
      await logRun(startedAtIso, wallet, r.found, r.written, r.complete && r.retire_error === null, error ? error.slice(0, 500) : null, {
        force,
        rows_found: r.found,
        rows_written: r.written,
        complete: r.complete,
        pages: r.pages,
        write_errors: r.write_errors.length,
        escrow_listed: r.escrow_listed,
        escrow_listed_written: r.escrow_listed_written,
        escrow_listed_stale: r.escrow_listed_stale,
        escrow_listed_capped: r.escrow_listed_capped,
        escrow_listed_error: r.escrow_listed_error,
        editions_inserted: r.editions_inserted,
        editions_error: r.editions_error,
        catalog_collections: r.catalog_collections,
        catalog_error: r.catalog_error,
        other_candy_items: r.other_candy?.items ?? null,
        retired: r.retired,
        ghosts_purged: r.ghosts_purged,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, wallet, 0, 0, false, e instanceof Error ? e.message : String(e), { force })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, wallet_address: wallet, force, started_at: startedAtIso },
    { status: 202 }
  )
}
