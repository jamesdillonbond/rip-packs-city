import { NextRequest, NextResponse, after } from "next/server"
import * as Sentry from "@sentry/nextjs"
import fcl from "@/lib/flow"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { decodeTopShotSaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"
import crypto from "crypto"

// The chain scan + ingest runs in after() so cron-job.org gets a fast 202
// instead of timing out on the synchronous ~24-33s body. Vercel keeps the
// after() work running up to maxDuration after the response is sent.
export const maxDuration = 120

// ── Auth ──────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DAPPER_MERCHANT = "0xc1e4f4f4c4257510"
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const TOPSHOT_MARKET_EVENT = "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased"
const CHUNK_SIZE = 250
const MAX_BLOCKS_PER_RUN = 5000
const INTER_CHUNK_DELAY_MS = 100

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTopShotNft(nftType: unknown): boolean {
  if (typeof nftType === "string") return nftType.includes("TopShot")
  if (nftType && typeof nftType === "object") {
    const obj = nftType as Record<string, unknown>
    if (typeof obj.typeID === "string") return obj.typeID.includes("TopShot")
    if (typeof obj.value === "string") return obj.value.includes("TopShot")
  }
  return false
}

function determineMarketplace(commissionReceiver: string | null): string {
  if (!commissionReceiver || commissionReceiver === DAPPER_MERCHANT) return "topshot"
  // Known Flowty addresses
  if (commissionReceiver.includes("flowty")) return "flowty"
  return "other"
}

// Canonical TopShot edition external_id: on-chain int pair (set:play) optionally
// with a ::subID parallel suffix. A non-canonical (UUID-pair) external_id is an
// inert dupe edition — a sale must NEVER be keyed onto one. The moments + wmc
// tables still contain canonically-wrong UUID-keyed rows from the pre-fix
// /api/ingest writer; trusting them re-creates the platform-wide sales
// mis-attribution (docs/scoping-2026-06-20-26-edition-misattribution.md). Any nft
// whose only candidate edition is non-canonical is dropped from the resolver maps
// here so it falls through to the Step 4d on-chain int-pair resolver instead.
const CANONICAL_EXT_RE = /^[0-9]+:[0-9]+(::[0-9]+)?$/
function isCanonicalExtId(ext: unknown): boolean {
  return typeof ext === "string" && CANONICAL_EXT_RE.test(ext)
}

// A ::subID parallel external_id (e.g. "257:8664::18"). Its base is the
// setID:playID before the "::". Used by the "when unmapped, base" guard below.
const PARALLEL_EXT_RE = /^([0-9]+:[0-9]+)::[0-9]+$/
function baseExtIdOf(ext: string): string | null {
  const m = PARALLEL_EXT_RE.exec(ext)
  return m ? m[1] : null
}

function toIsoTimestamp(ts: string | number | Date): string {
  if (typeof ts === "string") {
    // FCL returns ISO strings or epoch-like strings
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  if (typeof ts === "number") {
    // Could be seconds or milliseconds
    const d = new Date(ts > 1e12 ? ts : ts * 1000)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

// ── Pipeline observability ────────────────────────────────────────────────────

const PIPELINE_NAME = "topshot-sales-indexer"

async function writePipelineRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error: string | null
  cursorBefore: number | null
  cursorAfter: number | null
  extra: Record<string, unknown>
}): Promise<void> {
  // duration_ms is a GENERATED column — passing it on insert returns
  // 428C9 "cannot insert a non-DEFAULT value into column duration_ms",
  // which the previous version silently swallowed and lost the entire row.
  // We let Postgres compute it from started_at + finished_at.
  try {
    const { error } = await (supabaseAdmin as any).from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: "nba-top-shot",
      started_at: args.startedAt,
      finished_at: new Date().toISOString(),
      rows_found: args.rowsFound,
      rows_written: args.rowsWritten,
      rows_skipped: args.rowsSkipped,
      cursor_before: args.cursorBefore != null ? String(args.cursorBefore) : null,
      cursor_after: args.cursorAfter != null ? String(args.cursorAfter) : null,
      ok: args.ok,
      error: args.error,
      extra: args.extra,
    })
    if (error) {
      console.log("[sales-indexer] pipeline_runs insert error: code=" + ((error as any).code ?? "?") + " msg=" + (error.message ?? "?").slice(0, 200))
    }
  } catch (err) {
    console.log("[sales-indexer] pipeline_runs insert threw: " + (err instanceof Error ? err.message : String(err)))
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAtIso = new Date(start).toISOString()
  const debugMode = req.nextUrl.searchParams.get("debug") === "true"
  const chain = req.nextUrl.searchParams.get("chain") === "true"

  console.log(`[sales-indexer] proxy config: url=${process.env.TS_PROXY_URL ? 'SET' : 'UNSET'} secret=${process.env.TS_PROXY_SECRET ? 'SET' : 'UNSET'}`)

  // Auth check (Bearer header OR ?token= query param for cron-job.org)
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  // Fire-and-forget: schedule the scan + ingest, return 202 immediately so
  // cron-job.org reports Success instead of a cosmetic timeout. The route is
  // idempotent (dedups on sales.transaction_hash), so a fast return is safe
  // even with GH Actions + cron-job.org both firing.
  after(async () => {
  try {
    // Step 1: Read cursor
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "topshot_sales")
      .single()

    if (cursorErr) {
      console.log("[sales-indexer] cursor read error:", cursorErr.message)
      return
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)

    // Step 2: Get current sealed block height
    const latestBlock = await fcl.send([fcl.getBlock(true)]).then(fcl.decode)
    const currentHeight = Number(latestBlock.height)

    // If first run (cursor = 0), start 1000 blocks back
    if (lastBlock === 0) {
      lastBlock = currentHeight - 1000
      console.log("[sales-indexer] first run, starting from block", lastBlock)
    }

    // Cap blocks per run
    const targetHeight = Math.min(lastBlock + MAX_BLOCKS_PER_RUN, currentHeight)

    if (lastBlock >= currentHeight) {
      await writePipelineRun({
        startedAt: startedAtIso,
        rowsFound: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        ok: true,
        error: null,
        cursorBefore: lastBlock,
        cursorAfter: lastBlock,
        extra: { reason: "already_up_to_date", current_height: currentHeight },
      })
      await fireNextPipelineStep("/api/fmv-recalc", chain)
      return
    }

    console.log(`[sales-indexer] scanning blocks ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    // Step 3: Scan for events in chunks
    interface SaleEvent {
      blockHeight: number
      blockTimestamp: string
      transactionId: string
      source: "storefrontV2" | "topshotMarketV3"
      data: {
        listingResourceID?: string
        storefrontResourceID?: string
        purchased?: boolean
        nftType?: unknown
        nftUUID?: string
        nftID: string
        salePaymentVaultType?: string
        salePrice: string
        customID?: string | null
        commissionAmount?: string
        commissionReceiver?: string | null
        expiry?: string
        id?: string
        price?: string
        seller?: string
      }
    }

    const matchingEvents: SaleEvent[] = []
    let rawEventLogCount = 0

    for (let startH = lastBlock + 1; startH <= targetHeight; startH += CHUNK_SIZE) {
      const endH = Math.min(startH + CHUNK_SIZE - 1, targetHeight)

      // Scan NFTStorefrontV2 events
      try {
        const events = await fcl.send([
          fcl.getEventsAtBlockHeightRange(STOREFRONT_EVENT, startH, endH),
        ]).then(fcl.decode)

        if (Array.isArray(events)) {
          // Debug: log first 5 raw storefront events before any filtering
          if (debugMode && rawEventLogCount < 5) {
            for (const evt of events.slice(0, 5 - rawEventLogCount)) {
              const d = evt.data ?? evt
              console.log(`[sales-indexer][debug] raw StorefrontV2 event nftType type=${typeof d.nftType} value=${JSON.stringify(d.nftType)}`)
              console.log(`[sales-indexer][debug] raw StorefrontV2 event: ${JSON.stringify(evt)}`)
              rawEventLogCount++
            }
          }

          for (const evt of events) {
            const d = evt.data ?? evt
            if (d.purchased === true && isTopShotNft(d.nftType)) {
              matchingEvents.push({
                blockHeight: evt.blockHeight ?? startH,
                blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
                transactionId: evt.transactionId ?? null,
                source: "storefrontV2",
                data: d,
              })
            }
          }
        }
      } catch (err) {
        console.log(`[sales-indexer] StorefrontV2 chunk ${startH}-${endH} error:`, err instanceof Error ? err.message : String(err))
      }

      // Scan TopShotMarketV3 events
      try {
        const marketEvents = await fcl.send([
          fcl.getEventsAtBlockHeightRange(TOPSHOT_MARKET_EVENT, startH, endH),
        ]).then(fcl.decode)

        if (Array.isArray(marketEvents)) {
          if (debugMode && rawEventLogCount < 5) {
            for (const evt of marketEvents.slice(0, 5 - rawEventLogCount)) {
              console.log(`[sales-indexer][debug] raw TopShotMarketV3 event: ${JSON.stringify(evt)}`)
              rawEventLogCount++
            }
          }

          for (const evt of marketEvents) {
            const d = evt.data ?? evt
            matchingEvents.push({
              blockHeight: evt.blockHeight ?? startH,
              blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
              transactionId: evt.transactionId ?? null,
              source: "topshotMarketV3",
              data: {
                nftID: String(d.id ?? d.nftID),
                salePrice: String(d.price ?? d.salePrice ?? "0"),
                seller: d.seller ?? null,
              },
            })
          }
        }
      } catch (err) {
        console.log(`[sales-indexer] TopShotMarketV3 chunk ${startH}-${endH} error:`, err instanceof Error ? err.message : String(err))
      }

      if (startH + CHUNK_SIZE <= targetHeight) {
        await delay(INTER_CHUNK_DELAY_MS)
      }
    }

    console.log(`[sales-indexer] found ${matchingEvents.length} TopShot sale events (storefrontV2 + marketV3)`)

    if (matchingEvents.length === 0) {
      // Update cursor even if no events
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
        .eq("id", "topshot_sales")

      await writePipelineRun({
        startedAt: startedAtIso,
        rowsFound: 0,
        rowsWritten: 0,
        rowsSkipped: 0,
        ok: true,
        error: null,
        cursorBefore: lastBlock,
        cursorAfter: targetHeight,
        extra: { reason: "no_events", blocks_scanned: targetHeight - lastBlock },
      })
      await fireNextPipelineStep("/api/fmv-recalc", chain)
      return
    }

    // Step 4: Resolve nftID to edition
    const nftIds = matchingEvents.map((e) => String(e.data.nftID))
    const uniqueNftIds = [...new Set(nftIds)]

    // Which of these nfts are GENUINE parallels per the authoritative on-chain
    // subedition map (subedition_id > 0). Only these may keep a ::subID edition.
    // The cache/moments tables still hold Standard nfts mis-keyed to a parallel
    // edition (e.g. serial 551 on a /50 ::18) whose ::subID passes the canonical
    // FORMAT guard but is the wrong edition. The GQL fallback (Step 4d) already
    // resolves everything to the base setID:playID, so a ::subID assignment only
    // ever originates from a pre-existing 4a/4b row; the guard below (Step 4e)
    // redirects any unconfirmed ::subID to base, making 4a/4b consistent with 4d.
    // (docs/handoff-2026-07-02 F1 residual — closes the resolver gap so the
    // trickle stops, not just the daily self-healer sweep.)
    const confirmedParallelNfts = new Set<string>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data: subRows } = await (supabaseAdmin as any)
        .from("topshot_moment_subeditions")
        .select("nft_id")
        .in("nft_id", batch)
        .gt("subedition_id", 0)
      if (subRows) {
        for (const row of subRows) confirmedParallelNfts.add(String(row.nft_id))
      }
    }

    // 4a: Check wallet_moments_cache
    const cacheMap = new Map<string, { edition_key: string; serial_number: number | null }>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data: cacheRows } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .in("moment_id", batch)

      if (cacheRows) {
        for (const row of cacheRows) {
          if (row.edition_key) {
            cacheMap.set(row.moment_id, {
              edition_key: row.edition_key,
              serial_number: row.serial_number ?? null,
            })
          }
        }
      }
    }

    // 4b: Remaining — check moments table. CRITICAL: only TRUST a moments row
    // whose edition is CANONICAL (int-pair set:play or set:play::sub). The
    // moments table still holds ~1,200 canonically-wrong UUID-keyed rows from the
    // pre-fix /api/ingest writer; keying a sale onto one lands it on an inert
    // UUID-dupe edition (the mis-attribution writer). Non-canonical matches are
    // dropped so the nft falls through to the Step 4d on-chain GQL int-pair
    // resolver (getMintedMoment → set.flowId:play.flowID → ensure_..._stub).
    const remaining = uniqueNftIds.filter((id) => !cacheMap.has(id))
    const momentsMap = new Map<string, { editionId: string; serial: number | null }>()
    if (remaining.length > 0) {
      const rawMoments = new Map<string, { editionId: string; serial: number | null }>()
      for (let i = 0; i < remaining.length; i += 500) {
        const batch = remaining.slice(i, i + 500)
        const { data: momentRows } = await (supabaseAdmin as any)
          .from("moments")
          .select("nft_id, edition_id, serial_number")
          .in("nft_id", batch)

        if (momentRows) {
          for (const row of momentRows) {
            if (row.edition_id) {
              rawMoments.set(row.nft_id, {
                editionId: row.edition_id,
                serial: row.serial_number ?? null,
              })
            }
          }
        }
      }

      // Resolve each candidate edition_id → external_id and keep only the rows
      // whose edition is canonical. A UUID-dupe edition's nft falls through to GQL.
      const candidateEdIds = [...new Set([...rawMoments.values()].map((v) => v.editionId))]
      const canonicalEdIds = new Set<string>()
      for (let i = 0; i < candidateEdIds.length; i += 500) {
        const batch = candidateEdIds.slice(i, i + 500)
        const { data: edRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("id", batch)
          .eq("collection_id", TOPSHOT_COLLECTION_ID)

        if (edRows) {
          for (const row of edRows) {
            if (isCanonicalExtId(row.external_id)) canonicalEdIds.add(row.id)
          }
        }
      }

      for (const [nftId, v] of rawMoments) {
        if (canonicalEdIds.has(v.editionId)) momentsMap.set(nftId, v)
      }
    }

    // 4c: Resolve edition_keys to edition UUIDs
    const editionKeys = [...new Set([...cacheMap.values()].map((v) => v.edition_key))]
    const editionKeyToId = new Map<string, string>()
    if (editionKeys.length > 0) {
      for (let i = 0; i < editionKeys.length; i += 500) {
        const batch = editionKeys.slice(i, i + 500)
        const { data: edRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", batch)
          .eq("collection_id", TOPSHOT_COLLECTION_ID)

        if (edRows) {
          for (const row of edRows) {
            // Only trust canonical int-pair edition_keys. A wmc row keyed to a
            // UUID-dupe edition is dropped here → the nft falls through to Step 4d.
            if (isCanonicalExtId(row.external_id)) editionKeyToId.set(row.external_id, row.id)
          }
        }
      }
    }

    // Step 4d: GQL fallback for unresolved nftIDs
    const stillUnresolved = uniqueNftIds.filter((id) => {
      if (cacheMap.has(id) && editionKeyToId.has(cacheMap.get(id)!.edition_key)) return false
      if (momentsMap.has(id)) return false
      return true
    })

    const GQL_MAX = 50
    const GQL_DELAY_MS = 200
    const gqlResolvedMap = new Map<string, { editionId: string; serial: number | null }>()
    const proxyUrl = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"

    if (stillUnresolved.length > 0) {
      console.log(`[sales-indexer] attempting GQL resolution for ${Math.min(stillUnresolved.length, GQL_MAX)} of ${stillUnresolved.length} unresolved nftIDs`)

      // flowSerialNumber sits on MintedMoment directly; flowSeriesNumber on Set is the
      // series number (e.g. Series 4) — different concept. Pre-Apr 10 the indexer
      // did not include flowSerialNumber and every GQL-resolved row landed with serial=0.
      // Resolve to the CANONICAL on-chain int-pair edition (set.flowId:play.flowID),
      // NEVER the GQL UUID pair — UUID-pair external_ids are inert dupe editions and
      // were the writer behind the platform-wide sales mis-attribution
      // (docs/scoping-2026-06-20-26-edition-misattribution.md). Field casing matches
      // lib/editions-hydrate.ts + the moments hydrator and is verified live against
      // getMintedMoment via the proxy: set=flowId (number), play=flowID (string).
      const gqlQuery = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber play{...on Play{flowID}}set{...on Set{flowId}}}}}}`

      const gqlEditionCache = new Map<string, { editionId: string; serial: number | null }>()

      for (let i = 0; i < Math.min(stillUnresolved.length, GQL_MAX); i++) {
        const nftId = stillUnresolved[i]

        if (gqlEditionCache.has(nftId)) {
          gqlResolvedMap.set(nftId, gqlEditionCache.get(nftId)!)
          continue
        }

        try {
          console.log(`[sales-indexer] GQL attempting nftID=${nftId} url=${proxyUrl}`)
          const resp = await fetch(proxyUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(process.env.TS_PROXY_SECRET ? { "X-Proxy-Secret": process.env.TS_PROXY_SECRET } : {}),
            },
            body: JSON.stringify({
              query: gqlQuery,
              variables: { id: nftId },
            }),
          })

          console.log(`[sales-indexer] GQL response status=${resp.status}`)
          if (resp.ok) {
            const json = await resp.json()
            console.log(`[sales-indexer] GQL response body=${JSON.stringify(json).slice(0, 500)}`)
            const momentData = json?.data?.getMintedMoment?.data
            if (momentData) {
              // CANONICAL int-pair resolution. set.flowId / play.flowID are the on-chain
              // integer ids; their pair is the canonical editions.external_id. The old path
              // matched GQL UUIDs against editions.set_id/player_id (RPC's INTERNAL uuid
              // space — never matches) then fell back to a UUID-pair external_id, landing
              // sales on inert UUID-dupe editions. That was the mis-attribution writer.
              const setFlowIdRaw = momentData.set?.flowId
              const playFlowIdRaw = momentData.play?.flowID
              const rawSerial = momentData.flowSerialNumber
              const serial = rawSerial != null ? Number(rawSerial) : null
              const safeSerial = Number.isFinite(serial as number) ? (serial as number) : null

              const setN = setFlowIdRaw != null ? parseInt(String(setFlowIdRaw), 10) : NaN
              const playN = playFlowIdRaw != null ? parseInt(String(playFlowIdRaw), 10) : NaN
              if (Number.isFinite(setN) && Number.isFinite(playN)) {
                const extKey = `${setN}:${playN}`
                const { data: edRow } = await (supabaseAdmin as any)
                  .from("editions")
                  .select("id")
                  .eq("collection_id", TOPSHOT_COLLECTION_ID)
                  .eq("external_id", extKey)
                  .limit(1)
                  .maybeSingle()

                if (edRow?.id) {
                  const entry = { editionId: edRow.id, serial: safeSerial }
                  gqlResolvedMap.set(nftId, entry)
                  gqlEditionCache.set(nftId, entry)
                } else {
                  // No canonical int-pair edition yet (a genuinely new play). Self-heal via
                  // the same SECDEF stub the moments hydrator uses — creates a minimal
                  // int-keyed edition (inheriting set metadata) and returns its uuid. NEVER
                  // fall back to a UUID-pair external_id.
                  const { data: stubId } = await (supabaseAdmin as any).rpc("ensure_topshot_edition_stub", {
                    p_set_id_onchain: setN,
                    p_play_id_onchain: playN,
                  })
                  if (typeof stubId === "string" && stubId.length > 0) {
                    const entry = { editionId: stubId, serial: safeSerial }
                    gqlResolvedMap.set(nftId, entry)
                    gqlEditionCache.set(nftId, entry)
                  } else {
                    console.log(`[sales-indexer] GQL edition stub failed for ${extKey} (nftID=${nftId})`)
                  }
                }
              } else {
                console.log(`[sales-indexer] GQL missing on-chain ids for nftID=${nftId} set.flowId=${setFlowIdRaw} play.flowID=${playFlowIdRaw}`)
              }
            }
          } else {
            console.log(`[sales-indexer] GQL lookup failed for nftID=${nftId}: HTTP ${resp.status}`)
          }
        } catch (err) {
          console.log(`[sales-indexer] GQL lookup error for nftID=${nftId}:`, err instanceof Error ? err.message : String(err))
        }

        if (i < Math.min(stillUnresolved.length, GQL_MAX) - 1) {
          await delay(GQL_DELAY_MS)
        }
      }

      if (gqlResolvedMap.size > 0) {
        console.log(`[sales-indexer] GQL resolved ${gqlResolvedMap.size} additional editions`)
      }
    }

    // Step 4e: "when unmapped, base" guard maps. Reverse-resolve every edition id
    // that Step 5&6 could assign → its external_id, and for the ::subID ones,
    // resolve the base setID:playID edition id, so an unconfirmed parallel can be
    // redirected to base. Only ::subID editions matter, so this is a no-op when a
    // tick has no parallel-keyed resolutions.
    const assignableEdIds = new Set<string>()
    for (const id of editionKeyToId.values()) assignableEdIds.add(id)
    for (const v of momentsMap.values()) assignableEdIds.add(v.editionId)
    for (const v of gqlResolvedMap.values()) assignableEdIds.add(v.editionId)

    const edIdToExt = new Map<string, string>()
    const assignableArr = [...assignableEdIds]
    for (let i = 0; i < assignableArr.length; i += 500) {
      const batch = assignableArr.slice(i, i + 500)
      const { data: edRows } = await (supabaseAdmin as any)
        .from("editions")
        .select("id, external_id")
        .in("id", batch)
      if (edRows) {
        for (const row of edRows) if (row.external_id) edIdToExt.set(row.id, row.external_id)
      }
    }

    const baseKeyToId = new Map<string, string>()
    const baseKeysNeeded = new Set<string>()
    for (const ext of edIdToExt.values()) {
      const base = baseExtIdOf(ext)
      if (base) baseKeysNeeded.add(base)
    }
    if (baseKeysNeeded.size > 0) {
      const baseArr = [...baseKeysNeeded]
      for (let i = 0; i < baseArr.length; i += 500) {
        const batch = baseArr.slice(i, i + 500)
        const { data: edRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", batch)
          .eq("collection_id", TOPSHOT_COLLECTION_ID)
        if (edRows) {
          for (const row of edRows) baseKeyToId.set(row.external_id, row.id)
        }
      }
    }
    let parallelRedirects = 0

    // Step 5 & 6: Build and insert sales
    const salesBatch: any[] = []
    const unresolvedIds: string[] = []
    let serialsResolved = 0
    let serialsZero = 0

    for (const evt of matchingEvents) {
      const nftId = String(evt.data.nftID)
      let editionId: string | null = null
      let serialNumber: number | null = null

      const cached = cacheMap.get(nftId)
      if (cached) {
        editionId = editionKeyToId.get(cached.edition_key) ?? null
        serialNumber = cached.serial_number ?? null
      }

      if (!editionId) {
        const m = momentsMap.get(nftId)
        if (m) {
          editionId = m.editionId
          if (serialNumber == null) serialNumber = m.serial
        }
      }

      if (!editionId) {
        const g = gqlResolvedMap.get(nftId)
        if (g) {
          editionId = g.editionId
          if (serialNumber == null) serialNumber = g.serial
        }
      }

      if (!editionId) {
        unresolvedIds.push(nftId)
        continue
      }

      // Step 4e guard: a Standard nft must never land on a ::subID parallel. If the
      // resolved edition is a parallel but the on-chain submap does not confirm this
      // nft as a genuine parallel, redirect the sale to the base setID:playID edition
      // (the same edition Step 4d would have chosen). Confirmed parallels pass through.
      if (!confirmedParallelNfts.has(nftId)) {
        const ext = edIdToExt.get(editionId)
        const base = ext ? baseExtIdOf(ext) : null
        if (base) {
          const baseId = baseKeyToId.get(base)
          if (baseId && baseId !== editionId) {
            editionId = baseId
            parallelRedirects++
          }
        }
      }

      const marketplace = evt.source === "topshotMarketV3"
        ? "topshot"
        : determineMarketplace(evt.data.commissionReceiver ?? null)

      if (serialNumber != null && serialNumber > 0) serialsResolved++
      else serialsZero++

      salesBatch.push({
        id: crypto.randomUUID(),
        edition_id: editionId,
        collection_id: TOPSHOT_COLLECTION_ID,
        collection: "nba_top_shot",
        nft_id: nftId,
        price_usd: parseFloat(evt.data.salePrice) || 0,
        serial_number: serialNumber ?? 0,
        sold_at: toIsoTimestamp(evt.blockTimestamp),
        marketplace,
        source: "onchain",
        block_height: evt.blockHeight,
        transaction_hash: evt.transactionId ?? null,
        buyer_address: null,
        seller_address: evt.data.seller ?? null,
        payer_address: null,
        proposer_address: null,
        ingested_at: new Date().toISOString(),
      })
    }

    console.log(`[sales-indexer] resolved ${salesBatch.length} sales (${gqlResolvedMap.size} via GQL), ${unresolvedIds.length} unresolved, ${parallelRedirects} parallel→base redirects`)

    // Step 5b: Resolve buyer + execution accounts from the on-chain tx.
    // The MomentPurchased event carries seller but not buyer (the buyer is the
    // deposit recipient, which needs no signature). One /v1/transactions fetch
    // per sale recovers the buyer (TopShot.Deposit.to) AND the payer/proposer
    // accounts — the execution-venue signal that makes a new front-end like
    // dapper.market visible. Budgeted per tick so the route stays under
    // maxDuration; rows past the budget keep null buyer/exec and get picked up
    // by /api/admin/backfill-topshot-buyers.
    const TX_DECODE_MAX = 60
    const TX_DECODE_DELAY_MS = 60
    let buyersResolved = 0
    let execResolved = 0
    let decodeAttempts = 0
    const decodeTargets = salesBatch.filter((s) => s.transaction_hash)
    const decodeBudget = Math.min(decodeTargets.length, TX_DECODE_MAX)
    for (let i = 0; i < decodeBudget; i++) {
      const s = decodeTargets[i]
      decodeAttempts++
      try {
        const dec = await decodeTopShotSaleTx(String(s.transaction_hash), String(s.nft_id))
        if (dec.buyer) {
          s.buyer_address = dec.buyer
          buyersResolved++
        }
        if (!s.seller_address && dec.seller) s.seller_address = dec.seller
        if (dec.payer) s.payer_address = dec.payer
        if (dec.proposer) s.proposer_address = dec.proposer
        if (dec.payer || dec.proposer) execResolved++
      } catch (err) {
        console.log(`[sales-indexer] tx decode error for ${s.transaction_hash}:`, err instanceof Error ? err.message : String(err))
      }
      if (i < decodeBudget - 1) await delay(TX_DECODE_DELAY_MS)
    }
    console.log(`[sales-indexer] tx-decode: ${buyersResolved}/${decodeAttempts} buyers, ${execResolved} exec-accounts (budget ${TX_DECODE_MAX}, ${decodeTargets.length} candidates)`)

    // Insert in batches of 100
    let inserted = 0
    let duped = 0

    for (let i = 0; i < salesBatch.length; i += 100) {
      const batch = salesBatch.slice(i, i + 100)
      try {
        const { data: insertResult, error: insertErr } = await (supabaseAdmin as any)
          .from("sales")
          .insert(batch)

        if (insertErr) {
          // Unique constraint violation — some dupes
          if (insertErr.code === "23505") {
            duped += batch.length
          } else {
            console.log("[sales-indexer] batch insert error:", insertErr.message)
            duped += batch.length
          }
        } else {
          inserted += batch.length
        }
      } catch (err) {
        console.log("[sales-indexer] insert exception:", err instanceof Error ? err.message : String(err))
        // Try individual inserts for partial success
        for (const sale of batch) {
          try {
            const { error: singleErr } = await (supabaseAdmin as any)
              .from("sales")
              .insert(sale)
            if (singleErr) {
              duped++
            } else {
              inserted++
            }
          } catch {
            duped++
          }
        }
      }
    }

    // Step 7: Update cursor
    await (supabaseAdmin as any)
      .from("event_cursor")
      .update({ last_processed_block: targetHeight, updated_at: new Date().toISOString() })
      .eq("id", "topshot_sales")

    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: matchingEvents.length,
      rowsWritten: inserted,
      rowsSkipped: duped + unresolvedIds.length,
      ok: true,
      error: null,
      cursorBefore: lastBlock,
      cursorAfter: targetHeight,
      extra: {
        sales_resolved: salesBatch.length,
        gql_resolved: gqlResolvedMap.size,
        serials_resolved: serialsResolved,
        serials_zero: serialsZero,
        buyers_resolved: buyersResolved,
        exec_accounts_resolved: execResolved,
        tx_decode_attempts: decodeAttempts,
        tx_decode_candidates: decodeTargets.length,
        duped: duped,
        unresolved_count: unresolvedIds.length,
        parallel_redirects: parallelRedirects,
        blocks_scanned: targetHeight - lastBlock,
      },
    })

    // Step 8: Fire next pipeline step
    await fireNextPipelineStep("/api/fmv-recalc", chain)
  } catch (err) {
    Sentry.withScope((scope) => {
      scope.setTag("route", "sales-indexer")
      scope.setTag("collection", "nba-top-shot")
      Sentry.captureException(err)
    })
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[sales-indexer] fatal error:", msg)
    await writePipelineRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: msg.slice(0, 500),
      cursorBefore: null,
      cursorAfter: null,
      extra: { fatal: true },
    })
  }
  })

  return NextResponse.json({ status: "accepted" }, { status: 202 })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
