import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"
import {
  ALLDAY_COLLECTION_ID,
  COLLECTION_SLUG,
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

// ── AllDay unmapped-sales resolver (on-chain, Vercel egress) ──────────────────
//
// Replaces the Supabase edge function `allday-unmapped-resolver`, whose
// consumer-GraphQL leg (searchMomentNFTsV2 byFlowIDs via the topshot-proxy
// worker) is now hard-blocked by nflallday.com's Cloudflare WAF for all
// Cloudflare-Worker / Supabase-edge egress — it returned HTTP 403 "Blocked"
// and silently graveyarded every V1 AllDay sale it couldn't map, so AllDay
// sales/FMV/analytics were undercounting by a growing ~16% (diagnosed
// 2026-06-16). The marketplace GQL is a degrading third-party dependency; the
// chain is canonical and WAF-proof.
//
// This resolver runs on Vercel egress (Flow REST is reachable, unlike the
// AllDay GQL via worker) and drains unmapped_sales two ways:
//
//   Leg A — promote-via-wmc/hint (free): promote_unmapped_sales already
//     resolves any row whose nft_id is in wallet_moments_cache (Path 4) or
//     carries an edition resolution_hint. The old edge resolver returned early
//     whenever its GQL leg produced 0 mappings, so it NEVER ran promote on a
//     blocked tick — leaving those rows unpromoted. We always run promote.
//
//   Leg B — on-chain borrow: for the rest, recover the buyer from the sale tx
//     (AllDay.Deposit.to via decodeV1SaleTx, or the stored buyer_address) and
//     borrow the moment from the buyer's collection to read editionID +
//     serial. Fresh sales resolve before the buyer can re-sell, so new
//     accumulation stops. Old backlog rows whose buyer has since moved the
//     moment resolve only via Leg A (or remain a small residual — there is no
//     ownerless on-chain edition read).
//
// Chained from allday-sales-indexer (replacing the blocked edge-fn call). Can
// also run standalone via cron-job.org. Auth: Bearer INGEST_SECRET_TOKEN or
// ?token=. Result lands in pipeline_runs as pipeline=allday-unmapped-resolver.

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

// How many open rows to consider per run.
const CANDIDATE_LIMIT = 400
// Cap on-chain borrow attempts per run. Flow REST shares a ~20 req/s project
// budget; each attempt costs 1 tx-decode (only when buyer_address absent) + 1
// borrow script. 60 * ~3s ≈ comfortably under maxDuration.
const ON_CHAIN_MAX = 60
const CADENCE_DELAY_MS = 150
const PROMOTE_LIMIT = 1000

// Leg-B current-holder fallback (forward AllDay.Deposit scan). The sale's
// recorded buyer is a Dapper intermediate that re-deposits the moment into the
// real end-user wallet ~hundreds of blocks after the sale, so the fast
// buyer-borrow returns nil for ~every row. We then scan AllDay.Deposit forward
// from the sale block to find where the moment settled and borrow from there.
// Window 2000 blocks (~30 min) covers the observed +160..+440 block settle with
// margin (8 range-requests/nft). SCAN_CHUNK_BUDGET caps total range-requests per
// run so the cron stays well under maxDuration even with many nil candidates.
const SCAN_WINDOW_BLOCKS = 2000
const SCAN_CHUNK_BUDGET = 240
// Only run the (Flow-REST-costly) current-holder scan for rows sold recently —
// where the end-user who received the moment likely still holds a borrowable
// public AllDay collection. Older backlog rows have almost always moved into a
// non-public/escrow/burned state the borrow can't read (proven on-chain), so
// scanning them every tick just burns budget without ever resolving. Leg A
// (wmc/hint promote) still covers ALL ages every run; this gate is scan-only.
const SCAN_MAX_AGE_DAYS = 7

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

interface OpenRow {
  nft_id: string
  transaction_hash: string | null
  buyer_address: string | null
  serial_number: number | null
  block_height: number | null
  sold_at: string | null
}

interface MappingRow {
  nft_id: string
  edition_external_id: string
  serial_number: number | null
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error: string | null
  extra: Record<string, unknown>
}) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "allday-unmapped-resolver",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error,
      p_collection_slug: "nfl-all-day",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[allday-resolve-unmapped] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function run(startedAt: string) {
  const summary: Record<string, unknown> = {
    candidates: 0,
    needing_onchain: 0,
    onchain_attempted: 0,
    onchain_resolved: 0,
    onchain_nil: 0, // neither buyer nor settled holder holds the moment — retryable
    onchain_err: 0, // transport/RPC error talking to Flow — the real-trouble signal
    resolved_via_buyer: 0, // resolved by borrowing from the recorded buyer
    resolved_via_scan: 0, // resolved via the forward AllDay.Deposit current-holder scan
    scan_chunks: 0, // Flow REST /v1/events range-requests spent this run
    editions_hydrated: 0,
    mappings_written: 0,
    promoted: 0,
    still_unresolved: 0,
    fatal: null as string | null,
  }

  // 1. Load open, price-certain AllDay unmapped rows, freshest-SOLD first — the
  //    end-user who received a recent sale's moment is most likely to still hold
  //    a borrowable public collection (the current-holder scan can only resolve
  //    recent rows). Ordering by sold_at (not ingested_at) matters: the old
  //    backlog was re-ingested in bulk, so ingested_at desc surfaces ancient
  //    sales the scan can never resolve and starves the genuinely-recent rows.
  const { data: openData, error: openErr } = await (supabaseAdmin as any)
    .from("unmapped_sales")
    .select("nft_id, transaction_hash, buyer_address, serial_number, block_height, sold_at, price_usd")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .is("resolved_at", null)
    .gt("price_usd", 0)
    .order("sold_at", { ascending: false })
    .limit(CANDIDATE_LIMIT)

  if (openErr) {
    summary.fatal = `load_open:${openErr.message?.slice(0, 200)}`
    await logRun({ startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: false, error: summary.fatal as string, extra: summary })
    return
  }

  // Dedup by nft_id (a moment can have multiple unmapped sale rows; one mapping
  // promotes them all).
  const byNft = new Map<string, OpenRow>()
  for (const r of (openData ?? []) as Array<OpenRow & { price_usd: number }>) {
    if (!r.nft_id) continue
    if (!byNft.has(r.nft_id)) byNft.set(r.nft_id, { nft_id: r.nft_id, transaction_hash: r.transaction_hash, buyer_address: r.buyer_address, serial_number: r.serial_number, block_height: r.block_height, sold_at: r.sold_at })
  }
  const candidates = [...byNft.values()]
  summary.candidates = candidates.length

  // 2. Which nft_ids are already resolvable without any on-chain work — already
  //    in nft_edition_map, or in wmc with a valid edition? Those drain via the
  //    promote call (Leg A); skip on-chain for them.
  const nftIds = candidates.map((c) => c.nft_id)
  const alreadyMapped = new Set<string>()
  for (let i = 0; i < nftIds.length; i += 500) {
    const batch = nftIds.slice(i, i + 500)
    const [{ data: mapRows }, { data: wmcRows }] = await Promise.all([
      (supabaseAdmin as any).from("nft_edition_map").select("nft_id").eq("collection_id", ALLDAY_COLLECTION_ID).in("nft_id", batch),
      (supabaseAdmin as any).from("wallet_moments_cache").select("moment_id, edition_key").eq("collection_id", ALLDAY_COLLECTION_ID).in("moment_id", batch),
    ])
    for (const r of mapRows ?? []) alreadyMapped.add(r.nft_id)
    for (const r of wmcRows ?? []) if (r.edition_key) alreadyMapped.add(r.moment_id)
  }

  const needOnchain = candidates.filter((c) => !alreadyMapped.has(c.nft_id))
  summary.needing_onchain = needOnchain.length

  // 3. Leg B — on-chain borrow for the rows wmc/map can't cover.
  const newRows: MappingRow[] = []
  const resolvedEditionIds = new Set<string>()
  for (const row of needOnchain) {
    if ((summary.onchain_attempted as number) >= ON_CHAIN_MAX) break
    summary.onchain_attempted = (summary.onchain_attempted as number) + 1

    // Buyer candidates: stored buyer_address → AllDay.Deposit.to → tx envelope.
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
        /* fall through to tx-envelope candidates */
      }
      if (buyers.length === 0) {
        const txBuyers = await fetchTxBuyers(row.transaction_hash)
        for (const b of txBuyers) buyers.push(b)
      }
    }
    let editionID: string | null = null
    let serial = 0
    let hadError = false
    let resolvedViaScan = false

    // Fast path — borrow from the recorded buyer (works only on the rare row
    // where the sale's buyer is the end holder, not a Dapper intermediate).
    for (const buyer of buyers) {
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
        console.log(`[allday-resolve-unmapped] borrow err nft=${row.nft_id} buyer=${buyer}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await delay(CADENCE_DELAY_MS)
    }

    // Current-holder fallback — the buyer is stale, so scan AllDay.Deposit
    // forward from the sale block to find the wallet the moment settled into and
    // borrow from there. Newest in-window recipient first (the sale's own buyer
    // deposit is oldest and was already tried). Bounded by SCAN_CHUNK_BUDGET.
    const triedBuyers = new Set(buyers)
    const soldRecently =
      !!row.sold_at && Date.now() - new Date(row.sold_at).getTime() <= SCAN_MAX_AGE_DAYS * 86_400_000
    if (!editionID && soldRecently && row.block_height && (summary.scan_chunks as number) < SCAN_CHUNK_BUDGET) {
      const recipients = await scanAllDayDepositsForNft(
        row.nft_id,
        Number(row.block_height),
        SCAN_WINDOW_BLOCKS,
        () => { summary.scan_chunks = (summary.scan_chunks as number) + 1 },
      )
      for (let i = recipients.length - 1; i >= 0 && !editionID; i--) {
        const holder = recipients[i].to
        if (triedBuyers.has(holder)) continue
        triedBuyers.add(holder)
        try {
          const result = (await runAllDayScript(BORROW_MOMENT_SCRIPT, [
            { type: "Address", value: holder },
            { type: "UInt64", value: row.nft_id },
          ])) as Record<string, string> | null
          if (result && typeof result === "object" && result.editionID) {
            editionID = String(result.editionID)
            const s = Number(result.serialNumber)
            serial = Number.isFinite(s) ? s : 0
            resolvedViaScan = true
            break
          }
        } catch (err) {
          hadError = true
          console.log(`[allday-resolve-unmapped] scan-borrow err nft=${row.nft_id} holder=${holder}: ${err instanceof Error ? err.message : String(err)}`)
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
    if (resolvedViaScan) summary.resolved_via_scan = (summary.resolved_via_scan as number) + 1
    else summary.resolved_via_buyer = (summary.resolved_via_buyer as number) + 1
    await delay(CADENCE_DELAY_MS)
  }

  // 4. Ensure the resolved editions exist in `editions` (promote joins
  //    nft_edition_map → editions). Hydrate any missing ones on-chain.
  if (resolvedEditionIds.size > 0) {
    const ids = [...resolvedEditionIds]
    const existing = new Set<string>()
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500)
      const { data } = await (supabaseAdmin as any)
        .from("editions").select("external_id").eq("collection_id", ALLDAY_COLLECTION_ID).in("external_id", batch)
      for (const r of data ?? []) existing.add(r.external_id)
    }
    const missing = ids.filter((id) => !existing.has(id))
    if (missing.length > 0) {
      const now = new Date().toISOString()
      const upsertRows: Record<string, unknown>[] = []
      for (const editionID of missing) {
        try {
          const data = (await runAllDayScript(GET_EDITION_DATA_SCRIPT, [
            { type: "UInt64", value: editionID },
          ])) as Record<string, string> | null
          if (data && typeof data === "object") {
            upsertRows.push(buildOnChainEditionRow(editionID, data, now))
          }
        } catch (err) {
          console.log(`[allday-resolve-unmapped] getEditionData err edition=${editionID}: ${err instanceof Error ? err.message : String(err)}`)
        }
        await delay(CADENCE_DELAY_MS)
      }
      if (upsertRows.length > 0) {
        const { error: upErr } = await (supabaseAdmin as any)
          .from("editions").upsert(upsertRows, { onConflict: "external_id,collection_id", ignoreDuplicates: false })
        if (upErr) console.log(`[allday-resolve-unmapped] editions upsert err: ${upErr.message}`)
        else summary.editions_hydrated = upsertRows.length
      }
    }
  }

  // 5. Upsert the on-chain mappings + promote. Promote ALSO drains Leg A
  //    (wmc/hint-resolvable) rows, even when newRows is empty.
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

  // Throughput tripwire: a healthy run either resolves something or had nothing
  // to resolve. Flag (ok=false) only when we genuinely tried on-chain and every
  // attempt hit a Flow transport error AND nothing promoted — i.e. the resolver
  // is running but the resolution path is broken (the failure mode that hid the
  // GQL block). "buyer moved" (onchain_nil) is expected and never flags.
  const attempted = summary.onchain_attempted as number
  const resolved = summary.onchain_resolved as number
  const errs = summary.onchain_err as number
  const promoted = summary.promoted as number
  const degraded = attempted >= 5 && resolved === 0 && promoted === 0 && errs >= Math.ceil(attempted / 2)
  const ok = !summary.fatal && !degraded
  if (degraded) summary.degraded = true

  await logRun({
    startedAt,
    rowsFound: candidates.length,
    rowsWritten: (summary.mappings_written as number) + (summary.promoted as number),
    rowsSkipped: Math.max(0, candidates.length - (summary.promoted as number)),
    ok,
    error: (summary.fatal as string) ?? (degraded ? "degraded: onchain resolution failing, 0 promoted" : null),
    extra: summary,
  })

  console.log(
    `[allday-resolve-unmapped] candidates=${summary.candidates} need_onchain=${summary.needing_onchain} onchain_ok=${summary.onchain_resolved} (buyer=${summary.resolved_via_buyer} scan=${summary.resolved_via_scan}) scan_chunks=${summary.scan_chunks} mappings=${summary.mappings_written} promoted=${summary.promoted} still=${summary.still_unresolved}`,
  )
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const startedAt = new Date().toISOString()

  after(async () => {
    try {
      await run(startedAt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[allday-resolve-unmapped] fatal: ${msg.slice(0, 300)}`)
      await logRun({
        startedAt, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: msg.slice(0, 500), extra: { fatal: msg.slice(0, 500) },
      })
    }
  })

  return NextResponse.json({
    status: "accepted",
    collection_id: ALLDAY_COLLECTION_ID,
    started_at: startedAt,
    note: "Results appear in pipeline_runs as pipeline=allday-unmapped-resolver within ~10s.",
  }, { status: 202 })
}
