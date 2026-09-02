import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"
import { loadRotatingWindow } from "@/lib/unmapped-rotating-window"
import {
  ALLDAY_COLLECTION_ID,
  COLLECTION_SLUG,
  ALLDAY_DEPOSIT_EVENT,
  ALLDAY_WITHDRAW_EVENT,
  BORROW_MOMENT_SCRIPT,
  EXCLUDED_ADDRESSES,
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

// Rotating candidate window (2026-07-27). The candidate query used to be a bare
// `ORDER BY sold_at DESC LIMIT CANDIDATE_LIMIT` with no cursor, offset, or
// attempt-tracking of any kind. An unresolved row keeps `resolved_at IS NULL`
// forever, so EVERY tick re-selected the same rows — `candidates` was pinned at
// 385/386 across every run, spending the full ON_CHAIN_MAX budget on a fixed set
// that returned onchain_nil=60 / onchain_err=0 / resolved=0 every time.
//
// Only ~400 open AllDay rows are newer than ~2026-04-08, so this route's
// newest-400 plus the tail route's next-600 reached ~1,000 of 28,627 open
// distinct nft_ids; the other ~27,600 had never been probed and never could be.
//
// `unmapped_sales.last_onchain_attempt_at` (migration
// audit_20260727_unmapped_sales_onchain_attempt_cursor) is stamped for every row
// we ATTEMPT, whatever the outcome, and the window orders by it NULLS FIRST. So
// never-attempted rows lead, and a row we already probed is not re-probed until
// REATTEMPT_AFTER_DAYS has passed (a moment can re-sell into a borrowable wallet,
// so the horizon is a delay, not a permanent exclusion).
const REATTEMPT_AFTER_DAYS = 14

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
    resolved_via_decode: 0, // resolved from a tx-decoded buyer (deposit + envelope, below)
    // Decode sub-paths — the two legs cost DIFFERENT Flow REST calls, so split
    // them to make "is the envelope fallback worth its extra fetch?" a data
    // question. Invariant: resolved_via_decode == deposit + envelope.
    resolved_via_decode_deposit: 0, // resolved from decodeV1SaleTx's AllDay.Deposit.to (/v1/transaction_results)
    resolved_via_decode_envelope: 0, // resolved from a fetchTxBuyers envelope account (/v1/transactions)
    decode_envelope_fallback: 0, // rows where decode yielded no buyer ⇒ the extra /v1/transactions fetch ran
    buyer_excluded: 0, // stored buyer_address was a contract/custodian, not a wallet
    decode_attempted: 0, // rows that fell through to the tx-decode fallback
    scan_ran: 0, // rows the current-holder scan actually ran for
    scan_new_holders_tried: 0, // holders the scan surfaced that we had not tried
    scan_no_new_holder: 0, // scans that surfaced nothing we had not already tried
    scan_chunks: 0, // Flow REST /v1/events range-requests spent this run
    editions_hydrated: 0,
    mappings_written: 0,
    promoted: 0,
    still_unresolved: 0,
    attempt_stamped: 0, // rows advanced past the rotating window this run
    fatal: null as string | null,
  }

  // 1. Load open, price-certain AllDay unmapped rows through the ROTATING
  //    window: never-attempted first (last_onchain_attempt_at NULLS FIRST),
  //    then longest-since-attempted, with freshest-SOLD as the tiebreak.
  //
  //    sold_at DESC remains the tiebreak (not the primary sort) because the
  //    end-user who received a recent sale's moment is likeliest to still hold a
  //    borrowable public collection — but it can no longer PIN the window, which
  //    is what made this route re-probe the identical 385 rows every tick. On
  //    the first run after deploy every row is NULL, so ordering is byte-identical
  //    to the old behaviour; rotation only begins once rows carry a stamp.
  const reattemptCutoff = new Date(Date.now() - REATTEMPT_AFTER_DAYS * 86_400_000).toISOString()
  // Two bounded index range scans, not one `.or()`. The single-query form could
  // not stop early once the reattempt horizon went unreached — it walked the
  // whole unresolved AllDay set every tick to return nothing beyond the handful
  // of never-attempted rows. See lib/unmapped-rotating-window.ts for the
  // measurement and why the ordering is preserved exactly.
  const { data: openData, error: openErr, armCounts } = await loadRotatingWindow(
    supabaseAdmin,
    {
      collectionId: ALLDAY_COLLECTION_ID,
      columns:
        "nft_id, transaction_hash, buyer_address, serial_number, block_height, sold_at, price_usd",
      limit: CANDIDATE_LIMIT,
      reattemptCutoff,
    },
  )
  summary.window_never_attempted = armCounts.never_attempted
  summary.window_reattempt = armCounts.reattempt

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
  // Every nft we actually spend a borrow budget on, resolved or not. Stamped
  // below so the next tick moves on instead of re-probing this exact slate.
  const attemptedNftIds: string[] = []
  for (const row of needOnchain) {
    if ((summary.onchain_attempted as number) >= ON_CHAIN_MAX) break
    summary.onchain_attempted = (summary.onchain_attempted as number) + 1
    attemptedNftIds.push(row.nft_id)

    let editionID: string | null = null
    let serial = 0
    let hadError = false
    // Which leg resolved this row. Kept as one value (rather than a per-leg
    // boolean) so the three counters below can never double-count a row.
    let resolvedVia: "buyer" | "decode" | "scan" | null = null
    const triedBuyers = new Set<string>()

    // Borrow `nft_id` from one address. Returns true when it resolved.
    const tryBorrow = async (addr: string): Promise<boolean> => {
      if (!addr || triedBuyers.has(addr)) return false
      triedBuyers.add(addr)
      try {
        const result = (await runAllDayScript(BORROW_MOMENT_SCRIPT, [
          { type: "Address", value: addr },
          { type: "UInt64", value: row.nft_id },
        ])) as Record<string, string> | null
        if (result && typeof result === "object" && result.editionID) {
          editionID = String(result.editionID)
          const s = Number(result.serialNumber)
          serial = Number.isFinite(s) ? s : 0
          return true
        }
      } catch (err) {
        hadError = true
        console.log(`[allday-resolve-unmapped] borrow err nft=${row.nft_id} addr=${addr}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await delay(CADENCE_DELAY_MS)
      return false
    }

    // Stage 1 — the stored buyer_address, MINUS known non-wallet addresses.
    // EXCLUDED_ADDRESSES now carries the AllDay contract account, which is the
    // single most common stored buyer on this backlog (4,816 open rows, and the
    // only value still arriving today). Filtering it here is what lets stage 2
    // run for those rows at all.
    const buyers: string[] = []
    if (row.buyer_address) {
      const b = normalizeAddress(row.buyer_address)
      if (EXCLUDED_ADDRESSES.has(b)) summary.buyer_excluded = (summary.buyer_excluded as number) + 1
      else buyers.push(b)
    }
    for (const buyer of buyers) {
      if (await tryBorrow(buyer)) {
        resolvedVia = "buyer"
        break
      }
    }

    // Stage 2 — tx-decode fallback. Runs whenever stage 1 produced no edition,
    // NOT only when we had no buyer at all (the old `buyers.length === 0` gate).
    // That gate was the bug: any stored buyer_address — including the contract
    // address and Dapper custodians — suppressed this leg entirely, even though
    // AllDay.Deposit.to from the sale tx is where the real end-user lives. This
    // is the leg that produced 196 of 196 on-chain resolutions in the last 24h.
    if (!editionID && row.transaction_hash) {
      summary.decode_attempted = (summary.decode_attempted as number) + 1
      const decoded: string[] = []
      // Track which sub-path the winning candidate came from. decodeV1SaleTx
      // (Deposit.to) is tried first; the envelope fallback only populates when it
      // yields nothing, so the two are mutually exclusive per row.
      let decodeSource: "deposit" | "envelope" = "deposit"
      try {
        const dec = await decodeV1SaleTx(row.transaction_hash, {
          depositEventType: ALLDAY_DEPOSIT_EVENT,
          withdrawEventType: ALLDAY_WITHDRAW_EVENT,
          nftId: row.nft_id,
        })
        if (dec.buyer) decoded.push(normalizeAddress(dec.buyer))
      } catch {
        /* fall through to tx-envelope candidates */
      }
      if (decoded.length === 0) {
        decodeSource = "envelope"
        summary.decode_envelope_fallback = (summary.decode_envelope_fallback as number) + 1
        for (const b of await fetchTxBuyers(row.transaction_hash)) decoded.push(b)
      }
      for (const cand of decoded) {
        if (EXCLUDED_ADDRESSES.has(cand)) continue
        if (await tryBorrow(cand)) {
          resolvedVia = "decode"
          const subKey = decodeSource === "envelope" ? "resolved_via_decode_envelope" : "resolved_via_decode_deposit"
          summary[subKey] = (summary[subKey] as number) + 1
          break
        }
      }
    }

    // Stage 3 — current-holder scan. Premise: the sale's buyer is a Dapper
    // intermediate that re-deposits into the real wallet a few hundred blocks
    // later, so walk AllDay.Deposit forward and borrow from the newest in-window
    // recipient.
    //
    // MEASURED 2026-07-26: over 24h this leg spent 21,060 Flow REST range
    // requests (plus 3,224 on the tail route) and resolved EXACTLY ZERO rows.
    // Probing stuck rows on-chain shows why: the only in-window Deposit
    // recipient is the buyer we already tried, so every candidate hits the
    // `triedBuyers` skip below and the scan returns nil. Some moments go into
    // storefront escrow (a Listing resource, not a Collection) and have no
    // borrowable holder at all.
    //
    // Two guards, both cheap:
    //   - `buyers.length > 0` — if we never had a real wallet to begin with, the
    //     "buyer is stale, find where it moved" premise does not apply and the
    //     decode leg above is the correct tool.
    //   - instrumentation — `scan_ran` / `scan_new_holders_tried` /
    //     `scan_no_new_holder` separate "the scan found nothing new to try" from
    //     "it found a new holder that did not hold", so the decision to keep or
    //     delete this strategy is driven by data instead of re-derived.
    const soldRecently =
      !!row.sold_at && Date.now() - new Date(row.sold_at).getTime() <= SCAN_MAX_AGE_DAYS * 86_400_000
    if (
      !editionID &&
      soldRecently &&
      buyers.length > 0 &&
      row.block_height &&
      (summary.scan_chunks as number) < SCAN_CHUNK_BUDGET
    ) {
      summary.scan_ran = (summary.scan_ran as number) + 1
      const recipients = await scanAllDayDepositsForNft(
        row.nft_id,
        Number(row.block_height),
        SCAN_WINDOW_BLOCKS,
        () => { summary.scan_chunks = (summary.scan_chunks as number) + 1 },
        () => { hadError = true },
      )
      let newHolders = 0
      for (let i = recipients.length - 1; i >= 0 && !editionID; i--) {
        const holder = recipients[i].to
        if (triedBuyers.has(holder)) continue
        newHolders++
        summary.scan_new_holders_tried = (summary.scan_new_holders_tried as number) + 1
        if (await tryBorrow(holder)) {
          resolvedVia = "scan"
          break
        }
      }
      if (newHolders === 0) summary.scan_no_new_holder = (summary.scan_no_new_holder as number) + 1
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
    const viaKey =
      resolvedVia === "scan" ? "resolved_via_scan" : resolvedVia === "decode" ? "resolved_via_decode" : "resolved_via_buyer"
    summary[viaKey] = (summary[viaKey] as number) + 1
    await delay(CADENCE_DELAY_MS)
  }

  // 3b. Advance the rotating window. Stamped for every ATTEMPTED nft regardless
  //     of outcome — this is a "we spent budget here" marker, not a resolution
  //     marker (resolved_at stays the only success signal). Stamped by nft_id,
  //     not row id, because one moment can carry several unmapped sale rows and
  //     a single borrow attempt covers all of them; stamping only the deduped
  //     row would leave its siblings NULL and re-select the same moment.
  if (attemptedNftIds.length > 0) {
    const stampedAt = new Date().toISOString()
    for (let i = 0; i < attemptedNftIds.length; i += 500) {
      const batch = attemptedNftIds.slice(i, i + 500)
      // Via RPC, not a plain .update(): PostgREST cannot express a
      // column-referencing update (`onchain_attempts = onchain_attempts + 1`),
      // and the counter is what lets the resolution-backlog trust arm tell a row
      // that is genuinely stuck from one that is merely queued. Same nft_id
      // keying and same resolved_at IS NULL scope as before.
      const { data: stampCount, error: stampErr } = await (supabaseAdmin as any).rpc(
        "stamp_unmapped_onchain_attempt",
        { p_collection_id: ALLDAY_COLLECTION_ID, p_nft_ids: batch, p_at: stampedAt },
      )
      const count = typeof stampCount === "number" ? stampCount : 0
      // A failed stamp is not fatal (the run's real work already landed), but it
      // silently reinstates the stuck window, so it must be visible.
      if (stampErr) {
        summary.stamp_error = stampErr.message?.slice(0, 200)
        console.log(`[allday-resolve-unmapped] attempt-stamp failed: ${stampErr.message}`)
      } else {
        summary.attempt_stamped = (summary.attempt_stamped as number) + (count ?? 0)
      }
    }
  }

  // 4. Ensure the resolved editions exist in `editions` (promote joins
  //    nft_edition_map → editions). Hydrate any missing ones on-chain.
  if (resolvedEditionIds.size > 0) {
    const ids = [...resolvedEditionIds]
    const existing = new Set<string>()
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500)
      // ⚠ THROW — DO NOT `?? []` THIS. A failed read leaves `existing` empty, so
      // EVERY resolved edition falls into `missing` below and the loop issues one
      // on-chain `getEditionData` per id (each with a CADENCE_DELAY_MS pause) and
      // then upserts them all back over rows that were already there. A single
      // unread page turns a no-op into a Cadence storm large enough to push this
      // route past its own maxDuration — and none of it is visible, because the
      // reason is an error nobody looked at.
      const { data, error } = await (supabaseAdmin as any)
        .from("editions").select("external_id").eq("collection_id", ALLDAY_COLLECTION_ID).in("external_id", batch)
      if (error) throw new Error(`editions existence lookup: ${error.message}`)
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

  // Throughput tripwire.
  //
  // The old single condition required `errs >= attempted/2`, but `onchain_err`
  // only counts THROWN transport errors — a borrow that returns nil increments
  // `onchain_nil` instead. Measured over 24h: onchain_err was 0 on all 95 runs
  // while 5,504 of 5,700 attempts came back nil. So the tripwire was
  // unreachable by construction: it could only fire if Flow itself was down,
  // which is the one case that was already obvious. Meanwhile the sibling tail
  // route reported ok=true on runs that resolved and promoted literally nothing.
  //
  // Clause (b) is the fix — a productivity floor that does not care WHY nothing
  // resolved. It is guarded on `promoted === 0` too, so a run that drains rows
  // via Leg A (wmc/hint promote) without any on-chain hit still counts healthy.
  const attempted = summary.onchain_attempted as number
  const resolved = summary.onchain_resolved as number
  const errs = summary.onchain_err as number
  const promoted = summary.promoted as number
  const needed = summary.needing_onchain as number
  const degraded =
    // (a) transport is broken: most attempts threw, and nothing landed.
    (attempted >= 5 && resolved === 0 && promoted === 0 && errs >= Math.ceil(attempted / 2)) ||
    // (b) the window is STUCK: there was on-chain work to do and we probed none
    //     of it. That is a selection/cursor fault (the class this route shipped
    //     with), and unlike a yield shortfall it is always a real defect.
    //     `needed === 0` is the healthy fully-swept state — every candidate was
    //     already map/wmc-resolvable and promote drained it — so it is excluded.
    (needed > 0 && attempted === 0)
  const ok = !summary.fatal && !degraded
  if (degraded) summary.degraded = true

  // NON-fatal: a full slate of attempts resolved nothing.
  //
  // This WAS clause (b) and it reddened the run. Measured 2026-07-27 (Claude
  // Code): an independent on-chain probe resolved 0/40 rows sampled from the
  // never-probed backlog region AND 0/11 sampled from the in-window head, with
  // zero transport errors — every tx returned HTTP 200 and a decodable
  // AllDay.Deposit.to whose recipient simply no longer borrows (the moments sit
  // in Dapper custody / storefront escrow / non-public collections). So
  // "resolved 0 with a healthy transport" is the EXPECTED steady state of an
  // exhausted backlog, not a fault, and firing an alert on it every 20 minutes
  // is pure fatigue — the exact trap the sibling `scan_ineffective` flag was
  // created to avoid. Transport breakage still reds via clause (a); a stuck
  // window still reds via clause (b). This stays in `extra` so a genuine
  // recovery in yield is still observable.
  if (attempted >= 20 && resolved === 0 && promoted === 0) {
    summary.onchain_unproductive = true
  }

  // Separate, NON-fatal signal: the current-holder scan burned real Flow REST
  // budget and resolved nothing. Deliberately does NOT set ok=false — the run
  // may still be resolving productively via the buyer/decode legs, and flipping
  // the whole pipeline red for one ineffective leg is how alert fatigue starts.
  // It surfaces in `extra` so the keep-or-delete call on the scan strategy is
  // made from data.
  if ((summary.scan_chunks as number) >= 100 && (summary.resolved_via_scan as number) === 0) {
    summary.scan_ineffective = true
  }

  await logRun({
    startedAt,
    rowsFound: candidates.length,
    rowsWritten: (summary.mappings_written as number) + (summary.promoted as number),
    rowsSkipped: Math.max(0, candidates.length - (summary.promoted as number)),
    ok,
    error: (summary.fatal as string) ?? (degraded ? "degraded: onchain transport failing or candidate window stuck" : null),
    extra: summary,
  })

  console.log(
    `[allday-resolve-unmapped] candidates=${summary.candidates} need_onchain=${summary.needing_onchain} onchain_ok=${summary.onchain_resolved} (buyer=${summary.resolved_via_buyer} decode=${summary.resolved_via_decode}[deposit=${summary.resolved_via_decode_deposit} envelope=${summary.resolved_via_decode_envelope}/${summary.decode_envelope_fallback}] scan=${summary.resolved_via_scan}) buyer_excluded=${summary.buyer_excluded} nil=${summary.onchain_nil} err=${summary.onchain_err} scan_ran=${summary.scan_ran} scan_no_new=${summary.scan_no_new_holder} scan_chunks=${summary.scan_chunks} mappings=${summary.mappings_written} promoted=${summary.promoted} stamped=${summary.attempt_stamped} still=${summary.still_unresolved}${degraded ? " DEGRADED" : ""}${summary.onchain_unproductive ? " UNPRODUCTIVE" : ""}${summary.scan_ineffective ? " SCAN_INEFFECTIVE" : ""}`,
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
