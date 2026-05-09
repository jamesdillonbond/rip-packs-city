// lib/wallet-backfill-helpers.ts
//
// Shared helpers for the per-collection wallet enrichers
// (wallet-backfill-allday / pinnacle / golazos / ufc / etc). Each
// collection's route is a thin wrapper that supplies a Cadence script
// and config; everything else — Flow REST call, cached-id diff, upsert,
// last-refreshed stamp, pipeline_runs logging — lives here so adding a
// new collection is a 10-line route.
//
// Note: Top Shot's wallet-backfill stays on its own implementation
// because it ALSO walks per-moment metadata via Cadence. The other four
// collections write IDs only and trust their respective edition
// resolvers to fill in player/set/tier out-of-band (same trade-off
// documented in wallet-backfill-allday — we don't have working
// per-moment metadata Cadence for those collections, but we do have
// working ID enumeration).

import fcl from "@/lib/flow"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import {
  isWalletAddress,
  resolveTopShotUsernameCacheAware,
} from "@/lib/topshot-username-resolve"
import {
  GET_UNLOCKED_MOMENT_DETAILS,
  GET_UNLOCKED_MOMENT_DETAILS_RANGE,
} from "@/lib/allday-cadence"
import {
  GET_PINNACLE_UNLOCKED_DETAILS,
  GET_PINNACLE_UNLOCKED_DETAILS_RANGE,
} from "@/lib/cadence/pinnacle-wallet"

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"
const UPSERT_CHUNK = 200

// Paginated mega-wallet recovery: per-mode chunk size is the count of
// getIDs() indices walked per Cadence call. AllDay uses 1000 — borrowNFT
// + struct field reads (editionID, serialNumber) are cheap, ~10k compute
// per chunk. Pinnacle uses 500 — per-NFT MetadataViews.getTraits +
// getEditions iterates trait arrays so a 1000-NFT chunk on
// 0xb6f2481eba4df97b (1277 NFTs) tripped Cadence error 1110 itself
// (verified 2026-05-08); 500-NFT chunks fit under the 100k budget with
// margin. Soft deadline halts the chunk loop ~40s before the route's
// maxDuration=600 so the post-pass JOIN UPDATE and pipeline_runs row
// always land.
const PAGINATION_CHUNK_SIZE_BY_MODE: Record<"allday" | "pinnacle", number> = {
  allday: 1000,
  pinnacle: 500,
}
const PAGINATION_SOFT_DEADLINE_MS = 560_000

// Resolve a raw wallet input (0x-address or Top Shot username) to a 16-hex
// 0x address. Dapper SSO maps username → wallet for all 5 collections, so a
// TopShot resolution is authoritative for Pinnacle/Golazos/UFC/AllDay too.
// Without this step, Flow rejects raw usernames with HTTP 400 "Invalid Flow
// argument" in <100ms — the canonical reproducer being the seeded-wallets
// cron passing `jamesdillonbond` (username) verbatim through the
// multicollection orchestrator. Returns either a normalised 0x wallet or a
// structured error suitable for a 400 response body.
export type WalletResolution =
  | { ok: true; wallet: string }
  | { ok: false; error: string; reason?: string; input: string }

export async function resolveWalletInput(rawInput: string): Promise<WalletResolution> {
  const input = rawInput.trim()
  if (!input) return { ok: false, error: "wallet field required", input }
  if (isWalletAddress(input)) {
    return { ok: true, wallet: input.startsWith("0x") ? input : `0x${input}` }
  }
  const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, input)
  if (!outcome.found) {
    return { ok: false, error: "could not resolve username", reason: outcome.reason, input }
  }
  return { ok: true, wallet: outcome.walletAddress }
}

export interface BackfillCollectionConfig {
  /** snake_case slug used in pipeline_runs and last_refreshed_per_collection */
  slug: string
  /** UUID of the collection in public.collections */
  collectionUuid: string
  /** Cadence script that takes Address and returns [UInt64] / [Int] of NFT ids */
  cadenceScript: string
  /** Pipeline name written to pipeline_runs.pipeline */
  pipelineName: string
}

interface BackfillArgs {
  config: BackfillCollectionConfig
  startedAtIso: string
  startedMs: number
  wallet: string
  skipCached: boolean
  // force=true is set by the route when the caller passes ?force=true (or
  // {force: true}). It does not change the filtering logic on its own —
  // the route already translates force=true into skipCached=false so the
  // helper writes edition_key + serial_number on every on-chain row, even
  // ones already in wmc. We thread the flag through purely for telemetry
  // (pipeline_runs.extra.force) so we can distinguish a deliberate
  // re-enrichment sweep from a normal cron pass that happened to receive
  // skip_cached=false.
  force?: boolean
}

export async function fetchOnChainIds(cadence: string, wallet: string): Promise<string[]> {
  const body = {
    script: btoa(cadence),
    arguments: [btoa(JSON.stringify({ type: "Address", value: wallet }))],
  }
  const res = await fetch(`${FLOW_REST}?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  const arr: Array<{ value: string }> = decoded?.value ?? []
  return arr.map(v => String(v.value))
}

// Cadence error code 1106 ("max interaction with storage exceeded the limit")
// is a permanent property of mega-wallets like 0xe1f2a091f7bb5245 (20MB+
// inventory) — there is no retry that fixes it. The script literally cannot
// touch that much state in a single transaction. These wallets need a
// future sharded-scan implementation; until then we mark them ok:true with
// terminated_reason='storage_limit_exceeded' so they stop counting as a
// pipeline failure.
export function isStorageLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\b1106\b/.test(msg) || /max interaction with storage/.test(msg) || /storage.*exceed/.test(msg)
}

// Cadence error code 1110 ("computation exceeds limit (100000)") fires on
// mega-wallets when the script does per-NFT work (borrowNFT + getTraits +
// getEditions) and the cumulative compute crosses Flow's 100k budget. The
// canonical reproducer is 0x5f71947aea94eb43 (~7700 Pinnacle NFTs) against
// runPinnacleDetailsBackfill. Same blast radius as 1106 (storage limit) —
// retry doesn't help, the script literally can't process that much state in
// a single call. Long-term fix is pagination (slice getIDs() into chunks of
// ~1000 and chain multiple Cadence calls). Until then we mark ok=true with
// terminated_reason='computation_limit_exceeded' so the wallet stops
// counting as a pipeline failure.
export function isComputationLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /\b1110\b/.test(msg) || /computation exceeds limit/.test(msg)
}

// AllDay's GET_UNLOCKED_MOMENT_DETAILS exhibits a different failure shape
// on mega-wallets than Pinnacle does. Instead of a clean Cadence 1110
// computation_limit_exceeded, the upstream Flow access node returns a
// generic HTTP 500 with `error=internal server error` and the script
// path (`/v1/scripts`) embedded in the message — Flow's REST/Access API
// surfacing the per-script execution-budget breach as an opaque 500.
// Canonical reproducers (May 8, 2026): 0xb7700366fa738a43 (41,550 AllDay
// moments), 0x640705263fe8f11b (43,425 AllDay moments). Treated as
// equivalent to a 1110: ok=true, flagged_for_pagination=true, log
// terminated_reason='access_api_error_likely_computation_limit'. Same
// long-term fix as Pinnacle — paginated GET_ALLDAY_DETAILS_RANGE walking
// getIDs() in ~1000-NFT chunks.
export function isAccessApiInternalServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /error=internal server error/i.test(msg) && /v1\/scripts/i.test(msg)
}

// Wallet has no collection capability published at the /public path the
// Cadence script targets (typical reproducer: Pinnacle-only collectors
// surfaced into the AllDay queue via Flowty transactions). Flow REST returns
// HTTP 400 with `code = InvalidArgument desc = failed to ex…` (truncated
// tail not worth parsing). Distinguished from storage_limit by elapsed time:
// no_collection_capability bounces fast (~4s), storage_limit takes much
// longer. Permanent for the wallet/collection pair — no retry fixes it, the
// capability simply doesn't exist on chain.
export function isNoCollectionCapabilityError(err: unknown, elapsedMs?: number): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const hasShape = /Flow script HTTP 400/i.test(msg) && /code\s*=\s*InvalidArgument/i.test(msg)
  if (!hasShape) return false
  if (typeof elapsedMs === "number" && elapsedMs > 10_000) return false
  return true
}

async function logRun(args: {
  pipelineName: string
  collectionSlug: string
  startedAt: string
  wallet: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: args.pipelineName,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: args.collectionSlug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet: args.wallet, ...args.extra },
    })
  } catch (err) {
    console.warn(
      `[${args.pipelineName}] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function loadCachedMomentIds(wallet: string, collectionUuid: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  let from = 0
  while (true) {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[wallet-backfill] cached-id read failed: ${error.message}`)
      return ids
    }
    const rows = (data ?? []) as Array<{ moment_id: string }>
    for (const r of rows) ids.add(String(r.moment_id))
    if (rows.length < PAGE) break
    from += PAGE
  }
  return ids
}

// Map<moment_id, edition_key_present>. Used by the paginated-recovery
// pre-flight short-circuit: if every on-chain ID is already cached AND
// already has edition_key populated, the chunk loop would emit dozens of
// Cadence calls (~80s wasted Cadence/cron pass on Pinnacle mega-wallets,
// per 2026-05-08 telemetry) only to skip every row at the cachedIds.has
// filter. Sharing a single map between the short-circuit check and the
// chunk loop keeps it to one wmc read.
async function loadCachedMomentIdsAndKeys(
  wallet: string,
  collectionUuid: string,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  const PAGE = 1000
  let from = 0
  while (true) {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[wallet-backfill] cached-id-key read failed: ${error.message}`)
      return map
    }
    const rows = (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>
    for (const r of rows) map.set(String(r.moment_id), r.edition_key != null)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return map
}

async function stampLastRefreshed(wallet: string, slug: string) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("refresh_seeded_wallet_stats", { p_wallet_address: wallet })
  } catch { /* swallow */ }
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any)
      .from("seeded_wallets")
      .update({ last_refreshed_per_collection: { [slug]: new Date().toISOString() } })
      .eq("wallet_address", wallet)
  } catch { /* swallow */ }
}

// runIdOnlyBackfill — generic background runner for non-Top-Shot
// collections. Gets on-chain IDs via the supplied Cadence script,
// upserts ID-only rows to wallet_moments_cache, and stamps
// last_refreshed_per_collection. Per-moment metadata is intentionally
// left null; out-of-band edition resolvers populate player/set/tier on
// the editions table and reads JOIN at query time.
export async function runIdOnlyBackfill(args: BackfillArgs): Promise<{ rowsFound: number }> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0

  try {
    const onChainIds = await fetchOnChainIds(config.cadenceScript, wallet)
    if (onChainIds.length === 0) {
      await stampLastRefreshed(wallet, config.slug)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
        },
      })
      return { rowsFound: 0 }
    }

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet, config.collectionUuid) : new Set<string>()
    const idsToWrite = skipCached ? onChainIds.filter(id => !cachedIds.has(id)) : onChainIds
    const skippedCount = onChainIds.length - idsToWrite.length

    const now = new Date().toISOString()
    const rows = idsToWrite.map(id => ({
      wallet_address: wallet,
      collection_id: config.collectionUuid,
      moment_id: String(id),
      edition_key: null,
      player_name: null,
      set_name: null,
      tier: null,
      serial_number: null,
      series_number: null,
      acquired_at: null,
      fmv_usd: null,
      last_seen_at: now,
    }))

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[${config.pipelineName}] upsert err chunk=${i}: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? chunk.length
      }
    }

    await stampLastRefreshed(wallet, config.slug)

    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length, rowsWritten: totalUpserted, rowsSkipped: skippedCount,
      ok: true,
      extra: {
        on_chain_count: onChainIds.length,
        rows_to_write: idsToWrite.length,
        skipped_cached: skippedCount,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
      },
    })
    return { rowsFound: onChainIds.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const elapsedMs = Date.now() - startedMs
    if (isStorageLimitError(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "storage_limit_exceeded",
          flagged_for_sharded_scan: true,
          skip_cached: skipCached,
          force: !!force,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] wallet_too_large wallet=${wallet} — flagged for future sharded scan`)
      return { rowsFound: 0 }
    }
    if (isNoCollectionCapabilityError(err, elapsedMs)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "no_collection_capability",
          flagged_for_no_capability: true,
          skip_cached: skipCached,
          force: !!force,
          elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
        },
      })
      console.log(`[${config.pipelineName}] no_collection_capability wallet=${wallet} — wallet lacks ${config.slug} collection capability`)
      return { rowsFound: 0 }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs,
      },
    })
    console.error(`[${config.pipelineName}] error during backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0 }
  }
}

// triggerUfcEnrichmentChain — fire-and-forget loop that calls
// enrich-ufc-wallet edge function with paginated start values until done.
// Called from wallet-backfill-ufc after the ID-only wmc insert lands so
// per-moment chain metadata (edition_key, player_name, set_name, tier)
// gets populated without manual intervention. Up to 30 pages × 100
// moments = 3,000 moments per wallet enriched per backfill run; any
// remaining tail drains on the next cron pass.
export async function triggerUfcEnrichmentChain(wallet: string): Promise<{
  pagesFired: number
  totalEnriched: number
  done: boolean
}> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!supabaseUrl || !ingestToken) {
    return { pagesFired: 0, totalEnriched: 0, done: false }
  }
  const baseUrl = `${supabaseUrl}/functions/v1/enrich-ufc-wallet`
  let start = 0
  let pages = 0
  let enrichedTotal = 0
  let done = false
  const MAX_PAGES = 30
  while (pages < MAX_PAGES) {
    const url = new URL(baseUrl)
    url.searchParams.set("wallet", wallet)
    url.searchParams.set("start", String(start))
    url.searchParams.set("token", ingestToken)
    let json: any
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${ingestToken}` },
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) {
        console.warn(`[ufc-enrich-chain] HTTP ${res.status} wallet=${wallet} start=${start}`)
        break
      }
      json = await res.json()
    } catch (err) {
      console.warn(`[ufc-enrich-chain] fetch failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
    pages++
    enrichedTotal += Number(json?.enriched ?? 0)
    if (json?.done === true || json?.nextStart == null) {
      done = true
      break
    }
    start = Number(json.nextStart)
    if (!Number.isFinite(start) || start <= 0) break
  }
  return { pagesFired: pages, totalEnriched: enrichedTotal, done }
}

// runAllDayDetailsBackfill — AllDay-specific enriched backfill. Unlike the
// generic runIdOnlyBackfill which only writes (wallet, collection, moment_id)
// tuples, this calls GET_UNLOCKED_MOMENT_DETAILS — a single Cadence script
// that returns [[nftID, editionID, serialNumber], ...] for the whole wallet
// in one shot. We write edition_key (= editionID) and serial_number on
// every row, then run a single SQL JOIN UPDATE to backfill tier /
// player_name / set_name / team_name from the editions table.
//
// Why this exists: 98.5% of wallet_moments_cache rows for AllDay had
// edition_key NULL because the prior helper wrote ID-only and there was no
// out-of-band resolver populating wmc.edition_key. The editions table has
// rich per-edition metadata (tier, player_name, set_name, team_name) but no
// path was wiring it to wmc.
export async function runAllDayDetailsBackfill(args: BackfillArgs): Promise<{ rowsFound: number }> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0
  let postPassUpdated = 0

  try {
    const raw = await fcl.query({
      cadence: GET_UNLOCKED_MOMENT_DETAILS,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    const triples: string[][] = Array.isArray(raw) ? (raw as any) : []

    if (triples.length === 0) {
      await stampLastRefreshed(wallet, config.slug)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
          mode: "details_allday",
        },
      })
      return { rowsFound: 0 }
    }

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet, config.collectionUuid) : new Set<string>()
    const now = new Date().toISOString()
    const rows: Array<Record<string, unknown>> = []
    let skippedCount = 0
    for (const tri of triples) {
      if (!Array.isArray(tri) || tri.length < 2) continue
      const nftId = String(tri[0])
      const editionId = String(tri[1])
      const serialRaw = tri[2] != null ? Number(tri[2]) : null
      const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
        ? (serialRaw as number)
        : null
      if (skipCached && cachedIds.has(nftId)) { skippedCount++; continue }
      rows.push({
        wallet_address: wallet,
        collection_id: config.collectionUuid,
        moment_id: nftId,
        edition_key: editionId,
        serial_number: serial,
        // tier/player_name/set_name filled by post-pass JOIN UPDATE below.
        tier: null,
        player_name: null,
        set_name: null,
        series_number: null,
        acquired_at: null,
        fmv_usd: null,
        last_seen_at: now,
      })
    }

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[${config.pipelineName}] upsert err chunk=${i}: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? chunk.length
      }
    }

    // Post-pass JOIN UPDATE: backfill tier / player_name / set_name on rows
    // that just landed (and any older rows for this wallet/collection that
    // are still missing). The editions table is populated by separate
    // seeders; we only fill columns that are still NULL so a future
    // edition update doesn't clobber wallet-side overrides if any.
    try {
      // deno-lint-ignore no-explicit-any
      const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
        "backfill_wmc_metadata_from_editions",
        { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
      )
      if (updErr) {
        console.warn(`[${config.pipelineName}] post-pass update failed: ${updErr.message}`)
      } else if (updResult != null) {
        postPassUpdated = Number(updResult) || 0
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: triples.length, rowsWritten: totalUpserted, rowsSkipped: skippedCount,
      ok: true,
      extra: {
        on_chain_count: triples.length,
        rows_to_write: rows.length,
        skipped_cached: skippedCount,
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        mode: "details_allday",
      },
    })
    return { rowsFound: triples.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const elapsedMs = Date.now() - startedMs
    if (isStorageLimitError(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "storage_limit_exceeded",
          flagged_for_sharded_scan: true,
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_allday",
        },
      })
      return { rowsFound: 0 }
    }
    // Mega-wallet handlers — order matters. Check explicit Cadence 1110
    // first (rare on AllDay but cheap to detect), then the wider AllDay
    // generic-500 signature (`error=internal server error` + /v1/scripts).
    // Both fall through to the paginated recovery path which walks
    // getIDs()[start..start+1000] in chunks and stays under the 100k
    // computation budget per call. parentTerminatedReason distinguishes
    // the two trigger shapes in pipeline_runs.extra.recovered_from.
    if (isComputationLimitError(err)) {
      console.log(`[${config.pipelineName}] computation_limit wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        mode: "allday",
        parentTerminatedReason: "computation_limit_exceeded",
        parentErrorExcerpt: msg.slice(0, 200),
      })
    }
    if (isAccessApiInternalServerError(err)) {
      console.log(`[${config.pipelineName}] access_api_500 wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        mode: "allday",
        parentTerminatedReason: "access_api_error_likely_computation_limit",
        parentErrorExcerpt: msg.slice(0, 200),
      })
    }
    if (isNoCollectionCapabilityError(err, elapsedMs)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "no_collection_capability",
          flagged_for_no_capability: true,
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_allday",
        },
      })
      return { rowsFound: 0 }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs, mode: "details_allday",
      },
    })
    console.error(`[${config.pipelineName}] error during details backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0 }
  }
}

// runPinnacleDetailsBackfill — Pinnacle-specific enriched backfill. Mirrors
// runAllDayDetailsBackfill: a single Cadence call returns
// [{id, editionKey, serial}, ...] for the wallet, we upsert with edition_key
// + serial_number populated, then a Pinnacle-specific JOIN UPDATE backfills
// character_name / set_name / tier (= variant_type) / mint_count from the
// pinnacle_editions table.
//
// Why this exists (parallel to AllDay rationale): the pinnacle-nft-resolver
// only catches NFTs that fired recent on-chain Deposit events, so stable
// holdings (Trevor's 180 Pinnacle moments — only 1 mapped) were invisible
// to the resolver. Write-time enrichment closes that gap.
export async function runPinnacleDetailsBackfill(args: BackfillArgs): Promise<{ rowsFound: number }> {
  const { config, startedAtIso, startedMs, wallet, skipCached, force } = args
  let totalUpserted = 0
  let postPassUpdated = 0

  try {
    const raw = await fcl.query({
      cadence: GET_PINNACLE_UNLOCKED_DETAILS,
      args: (arg: any) => [arg(wallet, t.Address)],
    })
    type PinDetail = { id: string; editionKey: string | null; serial: string | null }
    const details: PinDetail[] = Array.isArray(raw) ? (raw as any) : []

    if (details.length === 0) {
      await stampLastRefreshed(wallet, config.slug)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0, terminated_reason: "no_more_moments",
          skip_cached: skipCached, force: !!force, elapsed_ms: Date.now() - startedMs,
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0 }
    }

    const cachedIds = skipCached ? await loadCachedMomentIds(wallet, config.collectionUuid) : new Set<string>()
    const now = new Date().toISOString()
    const rows: Array<Record<string, unknown>> = []
    let skippedCount = 0
    for (const d of details) {
      const nftId = String(d.id)
      const editionKey = d.editionKey != null ? String(d.editionKey) : null
      const serialRaw = d.serial != null ? Number(d.serial) : null
      const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
        ? (serialRaw as number)
        : null
      if (skipCached && cachedIds.has(nftId)) { skippedCount++; continue }
      rows.push({
        wallet_address: wallet,
        collection_id: config.collectionUuid,
        moment_id: nftId,
        edition_key: editionKey,
        serial_number: serial,
        // character_name/set_name/tier/mint_count filled by post-pass JOIN.
        character_name: null,
        set_name: null,
        tier: null,
        player_name: null,
        series_number: null,
        acquired_at: null,
        fmv_usd: null,
        last_seen_at: now,
      })
    }

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) {
        console.error(`[${config.pipelineName}] upsert err chunk=${i}: ${error.message}`)
      } else {
        totalUpserted += data?.length ?? chunk.length
      }
    }

    // Post-pass JOIN UPDATE against pinnacle_editions.
    try {
      // deno-lint-ignore no-explicit-any
      const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
        "backfill_pinnacle_wmc_metadata_from_editions",
        { p_wallet_address: wallet },
      )
      if (updErr) {
        console.warn(`[${config.pipelineName}] post-pass update failed: ${updErr.message}`)
      } else if (updResult != null) {
        postPassUpdated = Number(updResult) || 0
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: details.length, rowsWritten: totalUpserted, rowsSkipped: skippedCount,
      ok: true,
      extra: {
        on_chain_count: details.length,
        rows_to_write: rows.length,
        skipped_cached: skippedCount,
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: "no_more_moments",
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        mode: "details_pinnacle",
      },
    })
    return { rowsFound: details.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const elapsedMs = Date.now() - startedMs
    if (isStorageLimitError(err)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "storage_limit_exceeded",
          flagged_for_sharded_scan: true,
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0 }
    }
    if (isComputationLimitError(err)) {
      console.log(`[${config.pipelineName}] computation_limit wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        mode: "pinnacle",
        parentTerminatedReason: "computation_limit_exceeded",
        parentErrorExcerpt: msg.slice(0, 200),
      })
    }
    if (isAccessApiInternalServerError(err)) {
      console.log(`[${config.pipelineName}] access_api_500 wallet=${wallet} — falling through to paginated path`)
      return await runPaginatedDetailsBackfill({
        config, startedAtIso, startedMs, wallet, skipCached, force,
        mode: "pinnacle",
        parentTerminatedReason: "access_api_error_likely_computation_limit",
        parentErrorExcerpt: msg.slice(0, 200),
      })
    }
    if (isNoCollectionCapabilityError(err, elapsedMs)) {
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
        ok: true,
        extra: {
          terminated_reason: "no_collection_capability",
          flagged_for_no_capability: true,
          skip_cached: skipCached, force: !!force, elapsed_ms: elapsedMs,
          error_excerpt: msg.slice(0, 200),
          mode: "details_pinnacle",
        },
      })
      return { rowsFound: 0 }
    }
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: 0, rowsWritten: totalUpserted, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "error", skip_cached: skipCached,
        force: !!force,
        elapsed_ms: elapsedMs, mode: "details_pinnacle",
      },
    })
    console.error(`[${config.pipelineName}] error during details backfill for ${wallet}: ${msg}`)
    return { rowsFound: 0 }
  }
}

// runPaginatedDetailsBackfill — mega-wallet recovery path. Triggered from
// the catch handlers of runAllDayDetailsBackfill / runPinnacleDetailsBackfill
// when a single-shot details call breaches Flow's 100k computation budget
// (Cadence error 1110 OR access-API HTTP 500 with `error=internal server
// error` + /v1/scripts in the message). Walks getIDs() in per-mode
// chunk sizes via GET_*_DETAILS_RANGE(addr, start, count) and upserts
// per chunk so partial progress is durable even if a downstream chunk
// fails or the maxDuration soft deadline fires.
//
// Telemetry written to pipeline_runs.extra:
//   pagination_chunks         number of chunks that successfully fetched + upserted
//   pagination_chunk_errors   number of chunks that threw (skipped, not aborted)
//   pagination_total_ids      total getIDs() length walked (= on-chain count)
//   pagination_chunk_size     mode-specific chunk size (allday=1000, pinnacle=500)
//   pagination_elapsed_ms     duration of the paginated run only
//   recovered_from            parent terminated_reason that triggered this
//   parent_error_excerpt      first 200 chars of the original error message
interface PaginatedBackfillArgs extends BackfillArgs {
  mode: "allday" | "pinnacle"
  parentTerminatedReason: string
  parentErrorExcerpt: string
}

export async function runPaginatedDetailsBackfill(args: PaginatedBackfillArgs): Promise<{ rowsFound: number }> {
  const {
    config, startedAtIso, startedMs, wallet, skipCached, force,
    mode, parentTerminatedReason, parentErrorExcerpt,
  } = args
  const paginationStartedMs = Date.now()
  const fullMode = mode === "allday" ? "details_allday_paginated" : "details_pinnacle_paginated"
  const chunkSize = PAGINATION_CHUNK_SIZE_BY_MODE[mode]

  let totalUpserted = 0
  let postPassUpdated = 0
  let chunksProcessed = 0
  let chunkErrors = 0
  let onChainIds: string[] = []
  let hitSoftDeadline = false

  try {
    // Step 1: cheap getIDs() walk. Both CADENCE_ALLDAY and CADENCE_PINNACLE
    // do nothing per-NFT — they just borrow the public collection cap and
    // return getIDs(), well under the computation budget even at 40k+.
    const idScript = mode === "allday" ? CADENCE_ALLDAY : CADENCE_PINNACLE
    onChainIds = await fetchOnChainIds(idScript, wallet)

    if (onChainIds.length === 0) {
      // Shouldn't happen — the parent details call already proved IDs
      // existed (otherwise no computation_limit). Defensive log.
      await stampLastRefreshed(wallet, config.slug)
      await logRun({
        pipelineName: config.pipelineName,
        collectionSlug: config.slug,
        startedAt: startedAtIso, wallet,
        rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          on_chain_count: 0,
          terminated_reason: "no_more_moments",
          recovered_from: parentTerminatedReason,
          parent_error_excerpt: parentErrorExcerpt,
          skip_cached: skipCached, force: !!force,
          elapsed_ms: Date.now() - startedMs,
          pagination_chunks: 0,
          pagination_chunk_errors: 0,
          pagination_total_ids: 0,
          pagination_chunk_size: chunkSize,
          pagination_elapsed_ms: Date.now() - paginationStartedMs,
          mode: fullMode,
        },
      })
      return { rowsFound: 0 }
    }

    const cachedMap = skipCached
      ? await loadCachedMomentIdsAndKeys(wallet, config.collectionUuid)
      : new Map<string, boolean>()

    // Step 1.5: pre-flight short-circuit (added 2026-05-08). If every
    // on-chain ID is already cached AND edition_key is already populated
    // on those rows, the chunk loop is pure waste — it would emit 16+
    // Cadence calls (~50-80s for Pinnacle mega-wallets) only to skip
    // every row at the in-loop cache filter. Skipped only when force=true
    // (caller explicitly requested re-walk). Post-pass JOIN UPDATE still
    // runs because pinnacle_editions/editions metadata may have changed
    // since the prior cron tick. The chunk loop is bypassed entirely;
    // pagination_chunks is intentionally absent from telemetry to keep
    // dashboards distinguishing skipped-from-paginated runs cleanly.
    if (skipCached && !force && cachedMap.size > 0 && onChainIds.length > 0) {
      const preflightStartMs = Date.now()
      let allCachedAndEnriched = true
      for (const id of onChainIds) {
        if (cachedMap.get(id) !== true) {
          allCachedAndEnriched = false
          break
        }
      }
      if (allCachedAndEnriched) {
        try {
          if (mode === "allday") {
            // deno-lint-ignore no-explicit-any
            const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
              "backfill_wmc_metadata_from_editions",
              { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
            )
            if (updErr) {
              console.warn(`[${config.pipelineName}] preflight post-pass update failed: ${updErr.message}`)
            } else if (updResult != null) {
              postPassUpdated = Number(updResult) || 0
            }
          } else {
            // deno-lint-ignore no-explicit-any
            const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
              "backfill_pinnacle_wmc_metadata_from_editions",
              { p_wallet_address: wallet },
            )
            if (updErr) {
              console.warn(`[${config.pipelineName}] preflight post-pass update failed: ${updErr.message}`)
            } else if (updResult != null) {
              postPassUpdated = Number(updResult) || 0
            }
          }
        } catch (err) {
          console.warn(
            `[${config.pipelineName}] preflight post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await stampLastRefreshed(wallet, config.slug)
        await logRun({
          pipelineName: config.pipelineName,
          collectionSlug: config.slug,
          startedAt: startedAtIso, wallet,
          rowsFound: onChainIds.length, rowsWritten: 0, rowsSkipped: onChainIds.length,
          ok: true,
          extra: {
            on_chain_count: onChainIds.length,
            cached_count_with_key: onChainIds.length,
            terminated_reason: "all_ids_already_enriched",
            recovered_from: parentTerminatedReason,
            parent_error_excerpt: parentErrorExcerpt,
            skip_cached: skipCached,
            force: !!force,
            elapsed_ms: Date.now() - startedMs,
            preflight_elapsed_ms: Date.now() - preflightStartMs,
            post_pass_metadata_updated: postPassUpdated,
            mode: fullMode,
          },
        })
        return { rowsFound: onChainIds.length }
      }
    }

    const now = new Date().toISOString()
    let totalSkippedCached = 0

    // Step 2: chunk loop. Each iteration calls GET_*_DETAILS_RANGE for a
    // mode-specific id window, builds rows, upserts immediately. Per-chunk
    // errors are non-fatal (logged + counted); only a complete inability to
    // proceed throws out to the outer catch.
    for (let start = 0; start < onChainIds.length; start += chunkSize) {
      if (Date.now() - startedMs > PAGINATION_SOFT_DEADLINE_MS) {
        hitSoftDeadline = true
        console.log(`[${config.pipelineName}] paginated soft deadline hit at chunk start=${start}/${onChainIds.length}`)
        break
      }
      const count = Math.min(chunkSize, onChainIds.length - start)
      let chunkRows: Array<Record<string, unknown>> = []
      try {
        if (mode === "allday") {
          const raw = await fcl.query({
            cadence: GET_UNLOCKED_MOMENT_DETAILS_RANGE,
            args: (arg: any) => [
              arg(wallet, t.Address),
              arg(String(start), t.Int),
              arg(String(count), t.Int),
            ],
          })
          const triples: string[][] = Array.isArray(raw) ? (raw as any) : []
          for (const tri of triples) {
            if (!Array.isArray(tri) || tri.length < 2) continue
            const nftId = String(tri[0])
            const editionId = String(tri[1])
            const serialRaw = tri[2] != null ? Number(tri[2]) : null
            const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
              ? (serialRaw as number)
              : null
            if (skipCached && cachedMap.has(nftId)) { totalSkippedCached++; continue }
            chunkRows.push({
              wallet_address: wallet,
              collection_id: config.collectionUuid,
              moment_id: nftId,
              edition_key: editionId,
              serial_number: serial,
              tier: null,
              player_name: null,
              set_name: null,
              series_number: null,
              acquired_at: null,
              fmv_usd: null,
              last_seen_at: now,
            })
          }
        } else {
          type PinDetail = { id: string; editionKey: string | null; serial: string | null }
          const raw = await fcl.query({
            cadence: GET_PINNACLE_UNLOCKED_DETAILS_RANGE,
            args: (arg: any) => [
              arg(wallet, t.Address),
              arg(String(start), t.Int),
              arg(String(count), t.Int),
            ],
          })
          const details: PinDetail[] = Array.isArray(raw) ? (raw as any) : []
          for (const d of details) {
            const nftId = String(d.id)
            const editionKey = d.editionKey != null ? String(d.editionKey) : null
            const serialRaw = d.serial != null ? Number(d.serial) : null
            const serial = Number.isFinite(serialRaw as number) && (serialRaw as number) > 0
              ? (serialRaw as number)
              : null
            if (skipCached && cachedMap.has(nftId)) { totalSkippedCached++; continue }
            chunkRows.push({
              wallet_address: wallet,
              collection_id: config.collectionUuid,
              moment_id: nftId,
              edition_key: editionKey,
              serial_number: serial,
              character_name: null,
              set_name: null,
              tier: null,
              player_name: null,
              series_number: null,
              acquired_at: null,
              fmv_usd: null,
              last_seen_at: now,
            })
          }
        }
      } catch (chunkErr) {
        chunkErrors++
        const cmsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
        console.warn(`[${config.pipelineName}] paginated chunk start=${start} count=${count} failed: ${cmsg.slice(0, 200)}`)
        continue
      }
      chunksProcessed++

      for (let i = 0; i < chunkRows.length; i += UPSERT_CHUNK) {
        const sub = chunkRows.slice(i, i + UPSERT_CHUNK)
        // deno-lint-ignore no-explicit-any
        const { data, error } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .upsert(sub, { onConflict: "wallet_address,collection_id,moment_id" })
          .select("moment_id")
        if (error) {
          console.error(`[${config.pipelineName}] paginated upsert err chunk=${start}+${i}: ${error.message}`)
        } else {
          totalUpserted += data?.length ?? sub.length
        }
      }
    }

    // Step 3: post-pass JOIN UPDATE. AllDay backfills against editions;
    // Pinnacle against pinnacle_editions. Same RPC the non-paginated path
    // uses — fills tier / player_name / set_name (AllDay) or
    // character_name / set_name / tier / mint_count (Pinnacle).
    try {
      if (mode === "allday") {
        // deno-lint-ignore no-explicit-any
        const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
          "backfill_wmc_metadata_from_editions",
          { p_wallet_address: wallet, p_collection_id: config.collectionUuid },
        )
        if (updErr) {
          console.warn(`[${config.pipelineName}] paginated post-pass update failed: ${updErr.message}`)
        } else if (updResult != null) {
          postPassUpdated = Number(updResult) || 0
        }
      } else {
        // deno-lint-ignore no-explicit-any
        const { data: updResult, error: updErr } = await (supabaseAdmin as any).rpc(
          "backfill_pinnacle_wmc_metadata_from_editions",
          { p_wallet_address: wallet },
        )
        if (updErr) {
          console.warn(`[${config.pipelineName}] paginated post-pass update failed: ${updErr.message}`)
        } else if (updResult != null) {
          postPassUpdated = Number(updResult) || 0
        }
      }
    } catch (err) {
      console.warn(
        `[${config.pipelineName}] paginated post-pass update threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    await stampLastRefreshed(wallet, config.slug)

    // ok=true even with chunk errors — partial progress is captured and
    // the next cron pass will re-enrich any wallet still flagged. Only
    // pagination_failed (zero chunks succeeded) marks ok=false.
    const allChunksFailed = chunksProcessed === 0 && chunkErrors > 0
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length,
      rowsWritten: totalUpserted,
      rowsSkipped: totalSkippedCached,
      ok: !allChunksFailed,
      error: allChunksFailed ? "all_pagination_chunks_failed" : null,
      extra: {
        on_chain_count: onChainIds.length,
        skipped_cached: totalSkippedCached,
        post_pass_metadata_updated: postPassUpdated,
        terminated_reason: allChunksFailed
          ? "pagination_failed"
          : (hitSoftDeadline ? "soft_deadline" : "no_more_moments"),
        recovered_from: parentTerminatedReason,
        parent_error_excerpt: parentErrorExcerpt,
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        pagination_chunks: chunksProcessed,
        pagination_chunk_errors: chunkErrors,
        pagination_total_ids: onChainIds.length,
        pagination_chunk_size: chunkSize,
        pagination_elapsed_ms: Date.now() - paginationStartedMs,
        mode: fullMode,
      },
    })
    return { rowsFound: onChainIds.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logRun({
      pipelineName: config.pipelineName,
      collectionSlug: config.slug,
      startedAt: startedAtIso, wallet,
      rowsFound: onChainIds.length,
      rowsWritten: totalUpserted,
      rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        terminated_reason: "pagination_failed",
        recovered_from: parentTerminatedReason,
        parent_error_excerpt: parentErrorExcerpt,
        skip_cached: skipCached,
        force: !!force,
        elapsed_ms: Date.now() - startedMs,
        pagination_chunks: chunksProcessed,
        pagination_chunk_errors: chunkErrors,
        pagination_total_ids: onChainIds.length,
        pagination_chunk_size: chunkSize,
        pagination_elapsed_ms: Date.now() - paginationStartedMs,
        mode: fullMode,
      },
    })
    console.error(`[${config.pipelineName}] paginated backfill failed for ${wallet}: ${msg}`)
    return { rowsFound: onChainIds.length }
  }
}

// ── Cadence scripts (one per supported collection) ─────────────────────

export const CADENCE_ALLDAY = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/AllDayNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_PINNACLE = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_GOLAZOS = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazoNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

export const CADENCE_UFC = `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim()

// Collection UUIDs (from public.collections; verified May 6, 2026)
export const ALLDAY_COLLECTION_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"
export const PINNACLE_COLLECTION_UUID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
export const GOLAZOS_COLLECTION_UUID = "06248cc4-b85f-47cd-af67-1855d14acd75"
export const UFC_COLLECTION_UUID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
