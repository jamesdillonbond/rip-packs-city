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
import { paginateOwner, getAsset, type DasAsset } from "@/lib/chains/solana/das"
import { MAGIC_EDEN_SOLANA_ESCROW, listedMintsInEscrowForSeller } from "@/lib/chains/solana/escrow"
import { isBurnt,
  isPack,
  CANDY_MLB_COLLECTION_ADDRESS,
  CANDY_MLB_SLUG,
  candyDiscoveryReady,
  normalizeSerial,
  CANDY_MLB_UUID,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "wallet-backfill-candy"
const UPSERT_CHUNK = 500
// 8 was measured to draw DAS HTTP 429 on a 62-listing seller (2026-09-26);
// 2 with one backoff retry on a 429 stays under the helius-proxy rate limit.
const ESCROW_READ_CONCURRENCY = 2
const ESCROW_READ_BUDGET_MS = 200_000

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
    // R123 (2026-09-20): a rejected chunk was console.logged and the run row
    // still claimed ok=true. Non-fatal to the walk; not a success.
    const writeErrors: string[] = []
    const seenMoments = new Set<string>()
    // #145: cards this wallet has LISTED on Magic Eden sit in the escrow, so
    // the owner walk below cannot see them. Counted separately.
    let escrowListed = 0
    let escrowWritten = 0
    let escrowStale = 0
    let escrowCapped = false
    let escrowError: string | null = null
    try {
      await paginateOwner(wallet, async (items) => {
        const now = new Date().toISOString()
        const rows = (items as DasAsset[])
          .filter(inCandyCollection)
          .filter((a) => !isBurnt(a))
          .filter((a) => !isPack(a)) // packs are not moments — skip (they mix into the collection)
          .map((a) => {
            const s = normalizeSerial(a)
            if (!s.moment_id) return null
            // Trust DAS ownership, but stamp the queried wallet so a stale
            // owner field can't misattribute the row.
            return { ...s, wallet_address: wallet, last_seen_at: now }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
        for (const r of rows) seenMoments.add(String(r.moment_id))
        found += rows.length
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
          const chunk = rows.slice(i, i + UPSERT_CHUNK)
          const { data, error } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
            .select("moment_id")
          if (error) {
            console.log(`[${PIPELINE_NAME}] wmc upsert err: ${error.message}`)
            writeErrors.push(`wallet_moments_cache: ${error.message}`)
          } else {
            written += data?.length ?? chunk.length
          }
        }

        // Metadata denorm post-pass (2026-08-02) — the missing half of the
        // Candy wmc write path.
        //
        // normalizeSerial() emits exactly 6 columns (wallet_address,
        // collection_id, moment_id, edition_key, serial_number, image_url).
        // tier / set_name / mint_count / player_name / team_name are NOT in
        // the payload and were therefore NEVER filled by this route — unlike
        // every Flow wallet backfill, which calls this same RPC as a post-pass
        // (see runAllDayDetailsBackfill). Result: 18,932 of 25,375 Candy wmc
        // rows (74.6%) rendered unlabelled on the PUBLIC /insights/candy-mlb
        // surface. The 6,443 that were fine had been filled by a one-off
        // 2026-07-19 parity denorm; everything created after that date was
        // never enriched by anything.
        //
        // This is NOT the `set_name` re-NULLing class fixed on 2026-08-01 —
        // that was on `editions`. Because these columns are absent from the
        // upsert payload, PostgREST's ON CONFLICT DO UPDATE never touches
        // them, so a fill here is durable (verified: all 25,375 rows were
        // re-upserted 2026-08-02 08:40Z and every already-enriched row kept
        // its tier). The RPC is COALESCE-guarded — it only ever fills a NULL.
        try {
          const { error: denormErr } = await (supabaseAdmin as any).rpc(
            "backfill_wmc_metadata_from_editions",
            { p_wallet_address: wallet, p_collection_id: CANDY_MLB_UUID },
          )
          if (denormErr) {
            console.log(`[${PIPELINE_NAME}] wmc metadata denorm err: ${denormErr.message}`)
          }
        } catch (e) {
          console.log(`[${PIPELINE_NAME}] wmc metadata denorm threw: ${e instanceof Error ? e.message : String(e)}`)
        }
      })

      // #145: attribute this wallet's escrow-held LISTED cards back to it. Each
      // mint is re-read from DAS and written only if the escrow still holds it
      // (a listing row can outlive its sale by a tick); a failed listings read
      // fails the run — the wallet's holdings would otherwise be published as
      // complete while every listed card is missing.
      const listed = await listedMintsInEscrowForSeller(supabaseAdmin as any, wallet)
      escrowCapped = listed.capped
      if (listed.error) {
        escrowError = listed.error
      } else {
        const now = new Date().toISOString()
        const escrowRows: Array<Record<string, unknown>> = []
        const todo = listed.mints.filter((m) => !seenMoments.has(m))
        // Bounded: ESCROW_READ_CONCURRENCY DAS reads at a time, and none started
        // after ESCROW_READ_BUDGET_MS of the invocation — a big seller (487
        // listings measured 09-26) must not run the lambda into its kill, which
        // would write no run row at all. A budget stop is reported, not hidden.
        let next = 0
        let budgetHit = false
        const worker = async () => {
          while (next < todo.length) {
            if (Date.now() - startedMs > ESCROW_READ_BUDGET_MS) { budgetHit = true; return }
            const mint = todo[next++]
            let a: DasAsset
            try {
              try {
                a = await getAsset(mint)
              } catch (e) {
                if (!/HTTP 429/.test(e instanceof Error ? e.message : String(e))) throw e
                await new Promise((r) => setTimeout(r, 1500))
                a = await getAsset(mint)
              }
            } catch (e) {
              escrowError = `getAsset ${mint}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)
              continue
            }
            if (a?.ownership?.owner !== MAGIC_EDEN_SOLANA_ESCROW) { escrowStale++; continue }
            if (!inCandyCollection(a) || isBurnt(a) || isPack(a)) continue
            const s = normalizeSerial(a)
            if (!s.moment_id) continue
            escrowRows.push({ ...s, wallet_address: wallet, last_seen_at: now })
          }
        }
        await Promise.all(Array.from({ length: ESCROW_READ_CONCURRENCY }, worker))
        if (budgetHit || escrowCapped) {
          escrowError = escrowError ?? `incomplete: ${budgetHit ? "time budget reached" : `more than ${todo.length} active listings`}`
        }
        escrowListed = escrowRows.length
        found += escrowRows.length
        for (let i = 0; i < escrowRows.length; i += UPSERT_CHUNK) {
          const chunk = escrowRows.slice(i, i + UPSERT_CHUNK)
          const { data, error } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
            .select("moment_id")
          if (error) {
            writeErrors.push(`wallet_moments_cache (escrow-listed): ${error.message}`)
          } else {
            const n = data?.length ?? chunk.length
            written += n
            escrowWritten += n
          }
        }
      }
      const runOk = writeErrors.length === 0 && escrowError === null
      await logRun(
        startedAtIso,
        wallet,
        found,
        written,
        runOk,
        writeErrors.length
          ? `${writeErrors.length} rejected write(s): ${writeErrors.slice(0, 3).join(" | ")}`.slice(0, 500)
          : escrowError
            ? `escrow-listed read failed: ${escrowError}`.slice(0, 500)
            : null,
        {
          force,
          rows_found: found,
          rows_written: written,
          write_errors: writeErrors.length,
          escrow_listed: escrowListed,
          escrow_listed_written: escrowWritten,
          escrow_listed_stale: escrowStale,
          escrow_listed_capped: escrowCapped,
          escrow_listed_error: escrowError,
          duration_ms: Date.now() - startedMs,
        },
      )
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
