import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"
import {
  ALLDAY_COLLECTION_ID,
  ALLDAY_DEPOSIT_EVENT,
  ALLDAY_WITHDRAW_EVENT,
  BORROW_MOMENT_SCRIPT,
  GET_EDITION_DATA_SCRIPT,
  buildOnChainEditionRow,
  fetchTxBuyers,
  normalizeAddress,
  runAllDayScript,
  scanAllDayDepositsForNft,
} from "@/lib/chains/flow/allday-edition-onchain"

// ── AllDay unmapped-residue TAIL resolver (Phase 3 of the residue drain) ──────
//
// The live allday-unmapped-resolver only attempts on-chain edition resolution
// for rows sold in the last 7 days (SCAN_MAX_AGE_DAYS) and loads only the 400
// freshest-sold rows, so the OLD edition-unknown historical backfill residue is
// never even looked at. This route targets exactly that tail: price-certain,
// edition-unknown rows sold > 7 days ago, newest-of-the-tail first (the moment
// most recently changed hands is likeliest to still sit in a borrowable public
// AllDay collection).
//
// Yield is expected to be LOW and it is honestly measured: old moments have
// usually moved into a non-public/escrow/burned state the borrow can't read
// (proven on-chain, per the live resolver's note). Most of the tail's real
// value is instead absorbed for free by job 215 (nft_edition_map-from-sales)
// as these moments re-sell into a resolved sale — so this runs on a SPARSE
// cadence to keep Flow REST spend bounded. Synchronous, self-budgeted, dual-
// auth (CRON_SECRET cron or INGEST_SECRET_TOKEN manual). Logs to pipeline_runs
// as pipeline=allday-unmapped-resolver-tail.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const CRON = process.env.CRON_SECRET ?? ""
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-unmapped-resolver-tail"

const CANDIDATE_LIMIT = 600
const ON_CHAIN_MAX = 90 // borrow attempts per tick (each = up to 1 decode + 1 borrow + scan)
const CADENCE_DELAY_MS = 120
const PROMOTE_LIMIT = 1000
const SCAN_WINDOW_BLOCKS = 3000
const SCAN_CHUNK_BUDGET = 400 // Flow REST /v1/events range-requests per tick
const MIN_AGE_DAYS = 7 // only the tail the live resolver skips
const ELAPSED_BUDGET_MS = 220_000

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

interface OpenRow {
  nft_id: string
  transaction_hash: string | null
  buyer_address: string | null
  serial_number: number | null
  block_height: number | null
  sold_at: string | null
}

async function run(startedAt: string, startedMs: number) {
  const summary: Record<string, unknown> = {
    candidates: 0,
    need_onchain: 0,
    onchain_attempted: 0,
    onchain_resolved: 0,
    resolved_via_buyer: 0,
    resolved_via_scan: 0,
    onchain_nil: 0,
    onchain_err: 0,
    scan_chunks: 0,
    editions_hydrated: 0,
    mappings_written: 0,
    promoted: 0,
    still_unresolved: 0,
    fatal: null as string | null,
  }
  let ok = true

  try {
    const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 86_400_000).toISOString()
    // Price-certain, edition-unknown (no price marker), older than the live
    // resolver's window. Newest-of-the-tail first.
    const { data: openData, error: openErr } = await (supabaseAdmin as any)
      .from("unmapped_sales")
      .select("nft_id, transaction_hash, buyer_address, serial_number, block_height, sold_at")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .is("resolved_at", null)
      .gt("price_usd", 0)
      .lt("sold_at", cutoff)
      .order("sold_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
    if (openErr) {
      summary.fatal = `load_open:${openErr.message?.slice(0, 200)}`
      ok = false
      throw new Error(summary.fatal as string)
    }

    const byNft = new Map<string, OpenRow>()
    for (const r of (openData ?? []) as OpenRow[]) {
      if (!r.nft_id) continue
      if (!byNft.has(r.nft_id)) byNft.set(r.nft_id, r)
    }
    const candidates = [...byNft.values()]
    summary.candidates = candidates.length

    // Skip nfts already resolvable off-chain (map/wmc) — promote covers them.
    const nftIds = candidates.map((c) => c.nft_id)
    const alreadyMapped = new Set<string>()
    for (let i = 0; i < nftIds.length; i += 500) {
      const batch = nftIds.slice(i, i + 500)
      const [{ data: mapRows }, { data: wmcRows }] = await Promise.all([
        (supabaseAdmin as any)
          .from("nft_edition_map")
          .select("nft_id")
          .eq("collection_id", ALLDAY_COLLECTION_ID)
          .in("nft_id", batch),
        (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", ALLDAY_COLLECTION_ID)
          .in("moment_id", batch),
      ])
      for (const r of mapRows ?? []) alreadyMapped.add(r.nft_id)
      for (const r of wmcRows ?? []) if (r.edition_key) alreadyMapped.add(r.moment_id)
    }
    const needOnchain = candidates.filter((c) => !alreadyMapped.has(c.nft_id))
    summary.need_onchain = needOnchain.length

    const newRows: Array<{ nft_id: string; edition_external_id: string; serial_number: number | null }> = []
    const resolvedEditionIds = new Set<string>()

    for (const row of needOnchain) {
      if ((summary.onchain_attempted as number) >= ON_CHAIN_MAX) break
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      summary.onchain_attempted = (summary.onchain_attempted as number) + 1

      // Buyer candidates (fast path): stored buyer → decode → tx envelope.
      const buyers: string[] = []
      if (row.buyer_address) buyers.push(normalizeAddress(row.buyer_address))
      if (buyers.length === 0 && row.transaction_hash) {
        try {
          const dec = await decodeV1SaleTx(row.transaction_hash, {
            depositEventType: ALLDAY_DEPOSIT_EVENT,
            withdrawEventType: ALLDAY_WITHDRAW_EVENT,
            nftId: row.nft_id,
          })
          if (dec.buyer) buyers.push(normalizeAddress(dec.buyer))
        } catch {
          /* fall through */
        }
        if (buyers.length === 0) {
          for (const b of await fetchTxBuyers(row.transaction_hash)) buyers.push(b)
        }
      }

      let editionID: string | null = null
      let serial = 0
      let hadError = false
      let viaScan = false
      const tried = new Set<string>()

      for (const buyer of buyers) {
        tried.add(buyer)
        try {
          const result = (await runAllDayScript(BORROW_MOMENT_SCRIPT, [
            { type: "Address", value: buyer },
            { type: "UInt64", value: row.nft_id },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionID) {
            editionID = String(result.editionID)
            const s = Number(result.serialNumber)
            serial = Number.isFinite(s) ? s : 0
            break
          }
        } catch (err) {
          hadError = true
          console.log(`[${PIPELINE_NAME}] borrow err nft=${row.nft_id}: ${err instanceof Error ? err.message : String(err)}`)
        }
        await delay(CADENCE_DELAY_MS)
      }

      // Current-holder scan forward from the sale block.
      if (!editionID && row.block_height && (summary.scan_chunks as number) < SCAN_CHUNK_BUDGET) {
        const recipients = await scanAllDayDepositsForNft(
          row.nft_id,
          Number(row.block_height),
          SCAN_WINDOW_BLOCKS,
          () => {
            summary.scan_chunks = (summary.scan_chunks as number) + 1
          },
        )
        for (let i = recipients.length - 1; i >= 0 && !editionID; i--) {
          const holder = recipients[i].to
          if (tried.has(holder)) continue
          tried.add(holder)
          try {
            const result = (await runAllDayScript(BORROW_MOMENT_SCRIPT, [
              { type: "Address", value: holder },
              { type: "UInt64", value: row.nft_id },
            ])) as Record<string, string> | null
            if (result && typeof result === "object" && result.editionID) {
              editionID = String(result.editionID)
              const s = Number(result.serialNumber)
              serial = Number.isFinite(s) ? s : 0
              viaScan = true
              break
            }
          } catch (err) {
            hadError = true
            console.log(`[${PIPELINE_NAME}] scan-borrow err nft=${row.nft_id}: ${err instanceof Error ? err.message : String(err)}`)
          }
          await delay(CADENCE_DELAY_MS)
        }
      }

      if (!editionID) {
        if (hadError) summary.onchain_err = (summary.onchain_err as number) + 1
        else summary.onchain_nil = (summary.onchain_nil as number) + 1
        continue
      }

      newRows.push({
        nft_id: row.nft_id,
        edition_external_id: editionID,
        serial_number: serial > 0 ? serial : (row.serial_number ?? null),
      })
      resolvedEditionIds.add(editionID)
      summary.onchain_resolved = (summary.onchain_resolved as number) + 1
      if (viaScan) summary.resolved_via_scan = (summary.resolved_via_scan as number) + 1
      else summary.resolved_via_buyer = (summary.resolved_via_buyer as number) + 1
      await delay(CADENCE_DELAY_MS)
    }

    // Ensure resolved editions exist before promote joins nft_edition_map→editions.
    if (resolvedEditionIds.size > 0) {
      const ids = [...resolvedEditionIds]
      const existing = new Set<string>()
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("editions")
          .select("external_id")
          .eq("collection_id", ALLDAY_COLLECTION_ID)
          .in("external_id", batch)
        for (const r of data ?? []) existing.add(r.external_id)
      }
      const missing = ids.filter((id) => !existing.has(id))
      if (missing.length > 0) {
        const now = new Date().toISOString()
        const upsertRows: Record<string, unknown>[] = []
        for (const editionID of missing) {
          if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
          try {
            const data = (await runAllDayScript(GET_EDITION_DATA_SCRIPT, [
              { type: "UInt64", value: editionID },
            ])) as Record<string, string> | null
            if (data && typeof data === "object") upsertRows.push(buildOnChainEditionRow(editionID, data, now))
          } catch (err) {
            console.log(`[${PIPELINE_NAME}] getEditionData err edition=${editionID}: ${err instanceof Error ? err.message : String(err)}`)
          }
          await delay(CADENCE_DELAY_MS)
        }
        if (upsertRows.length > 0) {
          const { error: upErr } = await (supabaseAdmin as any)
            .from("editions")
            .upsert(upsertRows, { onConflict: "external_id,collection_id", ignoreDuplicates: false })
          if (upErr) console.log(`[${PIPELINE_NAME}] editions upsert err: ${upErr.message}`)
          else summary.editions_hydrated = upsertRows.length
        }
      }
    }

    // Write mappings + promote (promote also drains any wmc/hint-resolvable rows).
    try {
      const { data: resolveData, error: resolveErr } = await (supabaseAdmin as any).rpc(
        "resolve_unmapped_sales_for_collection",
        { p_collection_id: ALLDAY_COLLECTION_ID, p_rows: newRows, p_promote_limit: PROMOTE_LIMIT },
      )
      if (resolveErr) {
        summary.fatal = `resolve:${resolveErr.message?.slice(0, 200)}`
      } else {
        const j = (resolveData ?? {}) as Record<string, any>
        summary.mappings_written = Number(j.mapping_upserted ?? 0) || 0
        const pr = (j.promote_result ?? {}) as Record<string, any>
        summary.promoted = Number(pr.promoted ?? 0) || 0
        summary.still_unresolved = Number(pr.still_unresolved ?? 0) || 0
      }
    } catch (err) {
      summary.fatal = `resolve_throw:${err instanceof Error ? err.message.slice(0, 200) : "err"}`
    }
  } catch (err) {
    ok = false
    if (!summary.fatal) summary.fatal = err instanceof Error ? err.message.slice(0, 300) : String(err)
  }

  // Flag only genuine transport failure: attempted on-chain, resolved nothing,
  // and the majority errored. "buyer moved" (onchain_nil) is the expected tail
  // outcome and must never flag.
  const attempted = summary.onchain_attempted as number
  const errs = summary.onchain_err as number
  const degraded = attempted >= 10 && (summary.onchain_resolved as number) === 0 && errs >= Math.ceil(attempted / 2)
  ok = ok && !summary.fatal && !degraded
  if (degraded) summary.degraded = true

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: summary.candidates,
      p_rows_written: (summary.mappings_written as number) + (summary.promoted as number),
      p_rows_skipped: Math.max(0, (summary.candidates as number) - (summary.promoted as number)),
      p_ok: ok,
      p_error: (summary.fatal as string) ?? (degraded ? "degraded: tail on-chain resolution failing" : null),
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { ...summary, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log err: ${e instanceof Error ? e.message : String(e)}`)
  }

  console.log(
    `[${PIPELINE_NAME}] candidates=${summary.candidates} need_onchain=${summary.need_onchain} resolved=${summary.onchain_resolved} (buyer=${summary.resolved_via_buyer} scan=${summary.resolved_via_scan}) nil=${summary.onchain_nil} err=${summary.onchain_err} promoted=${summary.promoted}`,
  )
  return { ok, summary }
}

async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return unauthorized()

  const startedAt = new Date().toISOString()
  const { ok, summary } = await run(startedAt, Date.now())
  return NextResponse.json({ ok, pipeline: PIPELINE_NAME, ...summary }, { status: ok ? 200 : 500 })
}

export async function POST(req: NextRequest) {
  return handle(req)
}
export async function GET(req: NextRequest) {
  return handle(req)
}
