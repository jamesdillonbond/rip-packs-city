import { NextRequest, NextResponse, after } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { hydrateTopShotEditions, toUpsertRow } from "@/lib/editions-hydrate"

// ── Types ────────────────────────────────────────────────────────────────────

type SaleTransaction = {
  id: string
  price: number | null
  updatedAt: string | null
  txHash: string | null
  moment: {
    id: string
    flowId: string | null
    flowSerialNumber: string | null
    tier: string | null
    isLocked: boolean | null
    parallelID: string | null
    set: {
      id: string
      flowId: string | number | null
      flowName: string | null
      flowSeriesNumber: number | null
    } | null
    setPlay: {
      ID: string
      flowRetired: boolean | null
      circulations: {
        circulationCount: number | null
        forSaleByCollectors: number | null
        locked: number | null
      } | null
    } | null
    parallelSetPlay: {
      setID: string | null
      playID: string | null
      parallelID: string | null
    } | null
    play: {
      id: string
      flowID: string | number | null
      stats: {
        playerID: string | null
        playerName: string | null
        firstName: string | null
        lastName: string | null
        jerseyNumber: string | null
        teamAtMoment: string | null
        playCategory: string | null
        dateOfMoment: string | null
      } | null
    } | null
  } | null
}

type SearchTransactionsResponse = {
  searchMarketplaceTransactions?: {
    data?: {
      searchSummary?: {
        pagination?: {
          rightCursor?: string | null
        }
        data?: Array<{
          size?: number
          data?: SaleTransaction[]
        }>
      }
    }
  }
}

// ── GraphQL Query ─────────────────────────────────────────────────────────────

const SEARCH_TRANSACTIONS_QUERY = `
  query IngestRecentSales($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination {
            rightCursor
          }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id
                  price
                  updatedAt
                  txHash
                  moment {
                    id
                    flowId
                    flowSerialNumber
                    tier
                    isLocked
                    parallelID
                    set {
                      id
                      flowId
                      flowName
                      flowSeriesNumber
                    }
                    setPlay {
                      ID
                      flowRetired
                      circulations {
                        circulationCount
                        forSaleByCollectors
                        locked
                      }
                    }
                    parallelSetPlay {
                      setID
                      playID
                      parallelID
                    }
                    play {
                      id
                      flowID
                      stats {
                        playerID
                        playerName
                        firstName
                        lastName
                        jerseyNumber
                        teamAtMoment
                        playCategory
                        dateOfMoment
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatTier(tier: string | null): string {
  if (!tier) return "COMMON"
  const t = tier.toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("FANDOM")) return "FANDOM"
  return "COMMON"
}

// Prefer the integer-pair (set.flowId:play.flowID) on-chain key. That's the
// canonical TS edition external_id per the 2026-05-26 dedup merge. Falls back
// to UUID-pair only if the on-chain ids are missing from the GQL response —
// which shouldn't happen for live transactions but keeps the route resilient.
function buildEditionKey(tx: SaleTransaction): string | null {
  const onchain = extractOnchainIds(tx)
  if (onchain) return `${onchain.setIdOnchain}:${onchain.playIdOnchain}`

  const moment = tx.moment
  if (!moment) return null
  const psp = moment.parallelSetPlay
  const setId = psp?.setID ?? moment.set?.id
  const playId = psp?.playID ?? moment.play?.id
  if (!setId || !playId) return null
  return `${setId}:${playId}`
}

function extractOnchainIds(
  tx: SaleTransaction,
): { setIdOnchain: number; playIdOnchain: number } | null {
  const setFlowIdRaw = tx.moment?.set?.flowId ?? null
  const playFlowIdRaw = tx.moment?.play?.flowID ?? null
  if (setFlowIdRaw == null || playFlowIdRaw == null) return null
  const setN = Number(setFlowIdRaw)
  const playN = Number(playFlowIdRaw)
  if (!Number.isFinite(setN) || !Number.isFinite(playN)) return null
  return { setIdOnchain: parseInt(String(setFlowIdRaw), 10), playIdOnchain: parseInt(String(playFlowIdRaw), 10) }
}

// ── Supabase upserts ──────────────────────────────────────────────────────────

async function upsertPlayer(
  collectionId: string,
  stats: NonNullable<NonNullable<SaleTransaction["moment"]>["play"]>["stats"]
): Promise<string | null> {
  if (!stats?.playerID) return null

  const { data, error } = await supabaseAdmin
    .from("players")
    .upsert(
      {
        external_id: String(stats.playerID),
        collection_id: collectionId,
        collection: "nba_top_shot",
        name: stats.playerName ?? "Unknown Player",
        first_name: stats.firstName ?? null,
        last_name: stats.lastName ?? null,
        team: stats.teamAtMoment ?? null,
        jersey_number: toNum(stats.jerseyNumber),
      },
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[INGEST] upsertPlayer error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertSet(
  collectionId: string,
  set: NonNullable<NonNullable<SaleTransaction["moment"]>["set"]>,
  tier: string
): Promise<string | null> {
  if (!set?.id) return null

  const { data, error } = await supabaseAdmin
    .from("sets")
    .upsert(
      {
        external_id: set.id,
        collection_id: collectionId,
        name: set.flowName ?? "Unknown Set",
        series: toNum(set.flowSeriesNumber),
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
      },
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[INGEST] upsertSet error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertEdition(
  collectionId: string,
  playerId: string | null,
  setId: string | null,
  tx: SaleTransaction,
  editionKey: string
): Promise<string | null> {
  const moment = tx.moment
  if (!moment?.set || !moment?.play) return null

  const circulations = moment.setPlay?.circulations
  const tier = formatTier(moment.tier)
  const isRetired = moment.setPlay?.flowRetired ?? false
  const onchain = extractOnchainIds(tx)

  const { data, error } = await supabaseAdmin
    .from("editions")
    .upsert(
      {
        external_id: editionKey,
        collection_id: collectionId,
        player_id: playerId,
        set_id: setId,
        name: `${moment.play.stats?.playerName ?? "Unknown"} — ${moment.set.flowName ?? "Unknown Set"}`,
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
        series: toNum(moment.set.flowSeriesNumber),
        edition_kind: isRetired ? "LE" : "CC",
        circulation_count: toNum(circulations?.circulationCount),
        // On-chain integer ids written inline so editions_block_topshot_uuid_dupe_trg
        // can match an existing integer canonical on INSERT and block UUID dupes,
        // instead of letting a NULL-onchain row land and getting clobbered later.
        set_id_onchain: onchain?.setIdOnchain ?? null,
        play_id_onchain: onchain?.playIdOnchain ?? null,
        play_category: moment.play.stats?.playCategory ?? null,
        game_date: moment.play.stats?.dateOfMoment
          ? moment.play.stats.dateOfMoment.split("T")[0]
          : null,
      },
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[INGEST] upsertEdition error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertSale(
  collectionId: string,
  editionId: string,
  tx: SaleTransaction
): Promise<boolean> {
  if (!tx.txHash || !tx.price || !tx.updatedAt) {
    console.error("DB write failed: sale missing required fields", {
      txHash: !!tx.txHash,
      price: tx.price,
      updatedAt: !!tx.updatedAt,
      txId: tx.id,
    })
    return false
  }

  const price = toNum(tx.price)
  if (!price) {
    console.error("DB write failed: price parsed to null/zero", { raw: tx.price, txId: tx.id })
    return false
  }

  const serialNumber = toNum(tx.moment?.flowSerialNumber)
  const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

  // ── Write moments row ────────────────────────────────────────────────────
  // moments.nft_id is UNIQUE — upsert is safe.
  // moments.serial_number is NOT NULL — skip if missing.
  // This powers the flowty-sales route's nft_id → edition_id bridge.
  if (nftId && serialNumber !== null) {
    const { error: momentError } = await supabaseAdmin
      .from("moments")
      .upsert(
        {
          nft_id: nftId,
          edition_id: editionId,
          collection_id: collectionId,
          serial_number: serialNumber,
        },
        { onConflict: "nft_id", ignoreDuplicates: true }
      )

    if (momentError && momentError.code !== "23505") {
      console.error("[INGEST] upsertMoment error:", momentError.message)
    }
  }

  // ── Write sale row ────────────────────────────────────────────────────────
  const { error: saleError, status, statusText } = await supabaseAdmin.from("sales").insert({
    edition_id: editionId,
    collection_id: collectionId,
    serial_number: serialNumber ?? 0,
    price_usd: price,
    currency: "USD",
    marketplace: "topshot",
    transaction_hash: tx.txHash,
    sold_at: tx.updatedAt,
    nft_id: nftId,
  })

  if (saleError) {
    // Duplicate = already ingested, not an error
    if (saleError.message.includes("duplicate") || saleError.code === "23505") {
      return false
    }
    console.error("DB write failed:", saleError, { status, statusText, txId: tx.id })
    return false
  }

  console.log(`[INGEST] Sale written OK — txHash=${tx.txHash} price=${price} status=${status}`)
  return true
}

// ── Main ingestion logic ──────────────────────────────────────────────────────

async function fetchRecentSales(
  limit: number,
  cursor: string | null
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const data = await topshotGraphql<SearchTransactionsResponse>(
    SEARCH_TRANSACTIONS_QUERY,
    {
      input: {
        sortBy: "UPDATED_AT_DESC",
        filters: {},
        searchInput: {
          pagination: {
            cursor: cursor ?? "",
            direction: "RIGHT",
            limit,
          },
        },
      },
    }
  )

  const summary = data?.searchMarketplaceTransactions?.data?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null

  const transactions: SaleTransaction[] = []
  const dataField = summary?.data as unknown

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      const b = block as { data?: SaleTransaction[] }
      if (Array.isArray(b?.data)) {
        transactions.push(...b.data)
      }
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as { data?: SaleTransaction[] }
    if (Array.isArray(b.data)) {
      transactions.push(...b.data)
    }
  }

  if (transactions.length > 0) {
    const sample = transactions[0]
    console.log("[INGEST] Sample tx shape:", JSON.stringify({
      txId: sample.id,
      momentId: sample.moment?.id,
      flowId: sample.moment?.flowId ?? "null",
      serialNumber: sample.moment?.flowSerialNumber ?? "null",
      setId: sample.moment?.set?.id,
      playId: sample.moment?.play?.id,
      psp: sample.moment?.parallelSetPlay,
      price: sample.price,
      txHash: sample.txHash ? "present" : "null",
    }))
  } else {
    console.warn("[INGEST] No transactions in response. Summary keys:", JSON.stringify(Object.keys(summary ?? {})))
    console.warn("[INGEST] Summary.data type:", typeof dataField, Array.isArray(dataField) ? "array" : "not-array")
  }

  return { transactions, nextCursor }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") === "true"

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const batchSize = Math.min(Number(body.batchSize ?? 50), 200)
  const cursor = (body.cursor as string | null) ?? null

  // Run the full ingest asynchronously so the HTTP response returns inside
  // cron-job.org's 30s timeout even when processing takes longer.
  after(async () => {
    const startTime = Date.now()
    try {

    console.log(`[INGEST] Starting — batchSize=${batchSize} cursor=${cursor ?? "start"}`)
    console.log(`[INGEST] SUPABASE_SERVICE_ROLE_KEY set: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}, length: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0}`)

    // The NBA Top Shot collection UUID is a published constant (see
    // CLAUDE.md). Treat the lookup as a fast-path — if PostgREST 504s or the
    // row briefly disappears, fall back to the known ID instead of bailing
    // out of the whole ingest. The 17:22:52 production incident hit this
    // exact branch when the lookup failed transiently and silently dropped a
    // 200-tx batch.
    const TS_COLLECTION_ID_CONST = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
    let collectionId: string = TS_COLLECTION_ID_CONST
    try {
      const { data: collections, error: lookupErr } = await supabaseAdmin
        .from("collections")
        .select("id")
        .eq("slug", "nba_top_shot")
        .single()
      if (lookupErr) {
        console.warn(
          `[INGEST] collections lookup error (using const fallback): code=${lookupErr.code} msg=${(lookupErr.message ?? "").slice(0, 200)}`
        )
      } else if (collections?.id) {
        collectionId = collections.id
      } else {
        console.warn("[INGEST] collections row missing for slug=nba_top_shot — using const fallback")
      }
    } catch (lookupExc) {
      const m = lookupExc instanceof Error ? lookupExc.message : String(lookupExc)
      console.warn(`[INGEST] collections lookup threw (using const fallback): ${m.slice(0, 200)}`)
    }

    // Fetch recent sales from Top Shot
    const { transactions, nextCursor } = await fetchRecentSales(batchSize, cursor)

    console.log(`[INGEST] Fetched ${transactions.length} transactions`)

    // ── Hydrate-at-insert: pre-populate editions for new external_ids ─────────
    // The downstream upsertEdition path doesn't write player_name/set_name/
    // team_name, so a freshly inserted edition would land with those columns
    // NULL until a backfill ran. Mirror the flowty-sales / flowty-listings /
    // allday-pack-ev pattern: for any edition_key not yet in editions, hydrate
    // metadata from TopShot GraphQL first, then let the per-tx upsert fill in
    // the remaining columns (tier/series/edition_kind/circulation_count/...).
    try {
      const editionKeySet = new Set<string>()
      for (const tx of transactions) {
        const k = buildEditionKey(tx)
        if (k) editionKeySet.add(k)
      }
      const allKeys = Array.from(editionKeySet)
      if (allKeys.length > 0) {
        const { data: existingRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("external_id")
          .in("external_id", allKeys)
          .eq("collection_id", collectionId)
        const existingSet = new Set<string>(
          ((existingRows as { external_id: string }[] | null) ?? []).map(
            (r) => r.external_id,
          ),
        )
        const missing = allKeys.filter((k) => !existingSet.has(k))
        if (missing.length > 0) {
          const candidates = missing.length
          let hydratedCount = 0
          let redirectedCount = 0
          let fallbackCount = 0
          const failed: string[] = []

          const hydratedRows = await hydrateTopShotEditions(missing, { supabase: supabaseAdmin })
          const upsertRows: Record<string, unknown>[] = []
          for (const r of hydratedRows) {
            if (r.redirect) {
              // Canonical-resolved against an existing UUID-format edition;
              // skip upsert. Downstream upsertEdition writes on the editionKey,
              // which is now integer-pair (see buildEditionKey) and hits the
              // same canonical row via the (external_id, collection_id) conflict.
              redirectedCount++
              continue
            }
            if (r.ok) {
              hydratedCount++
            } else {
              fallbackCount++
              failed.push(r.external_id)
              console.warn(
                `[INGEST] hydrate-at-insert failed for ${r.external_id}; falling through to skeleton`,
              )
            }
            upsertRows.push(toUpsertRow(r))
          }

          if (upsertRows.length > 0) {
            try {
              const { error: hydrateErr } = await (supabaseAdmin as any)
                .from("editions")
                .upsert(upsertRows, {
                  onConflict: "external_id,collection_id",
                  ignoreDuplicates: false,
                })
              if (hydrateErr) {
                console.warn(
                  `[INGEST] hydrate-at-insert upsert error: ${hydrateErr.message}`,
                )
              }
            } catch (err) {
              console.warn(
                `[INGEST] hydrate-at-insert upsert threw: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }

          console.log(
            `[INGEST] hydrate-at-insert: candidates=${candidates} hydrated=${hydratedCount} redirected=${redirectedCount} fallback=${fallbackCount}` +
              (failed.length ? ` failed=${failed.slice(0, 5).join(",")}` : ""),
          )

          // Observability: a single pipeline_runs row per call site so we can
          // monitor silent hydrate-failure rates without scraping logs.
          try {
            await (supabaseAdmin as any).from("pipeline_runs").insert({
              pipeline: "editions-hydrate-at-insert",
              collection_slug: "nba-top-shot",
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
              rows_found: candidates,
              rows_written: hydratedCount,
              rows_skipped: fallbackCount,
              ok: true,
              error: null,
              extra: {
                site: "ingest",
                candidates,
                hydrated: hydratedCount,
                redirected: redirectedCount,
                fallback_skeleton: fallbackCount,
                failed_sample: failed.slice(0, 10),
              },
            })
          } catch {
            // Best-effort observability; don't block ingest on it.
          }
        }
      }
    } catch (err) {
      console.warn(
        `[INGEST] hydrate-at-insert step error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    let salesIngested = 0
    let momentsWritten = 0
    let editionsUpdated = 0
    let duplicates = 0
    let errors = 0

    for (const tx of transactions) {
      try {
        const moment = tx.moment
        if (!moment?.play?.stats || !moment?.set) continue

        const price = toNum(tx.price)
        if (!price || price <= 0) continue

        const editionKey = buildEditionKey(tx)
        if (!editionKey) continue

        // Upsert player, set, edition
        const playerId = await upsertPlayer(collectionId, moment.play.stats)
        const tier = formatTier(moment.tier)
        const setDbId = await upsertSet(collectionId, moment.set, tier)
        const editionId = await upsertEdition(collectionId, playerId, setDbId, tx, editionKey)
        if (!editionId) continue

        editionsUpdated++

        // Insert sale (also writes moments row as a side effect)
        const prevMomentCount = momentsWritten
        const inserted = await upsertSale(collectionId, editionId, tx)

        // Detect if a moments row was written by checking flowId presence
        if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
          momentsWritten++
        }

        if (inserted) {
          salesIngested++
        } else {
          // Duplicate sale — don't double-count moment
          if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
            momentsWritten = prevMomentCount // revert increment for dupes
          }
          duplicates++
        }
      } catch (err) {
        console.error("[INGEST] Transaction error:", err)
        errors++
      }
    }

    const duration = Date.now() - startTime

    console.log(
      `[INGEST] Done — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} errors=${errors} duration=${duration}ms`
    )

    await fireNextPipelineStep("/api/sales-indexer", chain)
    console.log(
      `[INGEST] Summary — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} errors=${errors} nextCursor=${nextCursor ?? "null"} durationMs=${duration}`
    )
    } catch (e) {
      console.error("[INGEST] Fatal error:", e instanceof Error ? e.message : String(e))
    }
  })

  return NextResponse.json({
    ok: true,
    message: "Ingest triggered",
    triggeredAt: new Date().toISOString(),
  })
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}