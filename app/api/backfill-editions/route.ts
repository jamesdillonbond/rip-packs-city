import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Uses searchMarketplaceTransactions — proven to work in backfill/route.ts.
// Extracts integer setID/playID from parallelSetPlay on each moment.
const SEARCH_TRANSACTIONS_QUERY = `
  query BackfillEditions($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id
                  moment {
                    id
                    set { id flowName flowSeriesNumber }
                    play {
                      id
                      stats {
                        playerName teamAtMoment
                      }
                    }
                    setPlay {
                      ID flowRetired
                      circulations { circulationCount }
                    }
                    parallelSetPlay { setID playID }
                    tier
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

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

interface TransactionMoment {
  id: string
  set?: { id: string; flowName?: string; flowSeriesNumber?: number }
  play?: { id: string; stats?: { playerName?: string; teamAtMoment?: string } }
  setPlay?: { ID?: string; flowRetired?: boolean; circulations?: { circulationCount?: number } }
  parallelSetPlay?: { setID?: number; playID?: number }
  tier?: string
}

interface SaleTransaction {
  id: string
  moment?: TransactionMoment
}

async function fetchTransactionsPage(
  limit: number,
  cursor: string | null
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const res = await fetch(TOPSHOT_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      query: SEARCH_TRANSACTIONS_QUERY,
      variables: {
        input: {
          sortBy: "UPDATED_AT_DESC",
          searchInput: {
            pagination: {
              cursor: cursor ?? "",
              direction: "RIGHT",
              limit,
            },
          },
        },
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GQL ${res.status}: ${text.slice(0, 300)}`)
  }

  const json = await res.json()
  const summary = json?.data?.searchMarketplaceTransactions?.data?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null
  const transactions: SaleTransaction[] = []
  const dataField = summary?.data

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      if (Array.isArray(block?.data)) {
        transactions.push(...block.data)
      }
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as any
    if (Array.isArray(b.data)) {
      transactions.push(...b.data)
    }
  }

  return { transactions, nextCursor }
}

export async function POST(req: Request) {
  // Auth check
  const auth = req.headers.get("x-ingest-token")
  if (auth !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startTime = Date.now()
  let cursor: string | null = null
  let pagesProcessed = 0
  let editionsFound = 0
  let editionsUpdated = 0
  const maxPages = 20
  const batchSize = 200

  // Collect unique editions: key "setID:playID" → metadata
  const editionMap = new Map<string, {
    setIdOnchain: number
    playIdOnchain: number
    setUuid: string | null
    playUuid: string | null
    playerName: string | null
    teamAtMoment: string | null
    setName: string | null
    series: number | null
    tier: string | null
    circulationCount: number | null
  }>()

  try {
    // Phase 1: Fetch transactions from GQL and extract unique editions
    for (let page = 0; page < maxPages; page++) {
      const { transactions, nextCursor } = await fetchTransactionsPage(batchSize, cursor)
      pagesProcessed++

      if (transactions.length === 0) break

      for (const tx of transactions) {
        const m = tx.moment
        if (!m) continue

        const psp = m.parallelSetPlay
        const setID = psp?.setID
        const playID = psp?.playID
        if (setID == null || playID == null) continue
        if (isNaN(setID) || isNaN(playID)) continue

        const key = `${setID}:${playID}`
        if (!editionMap.has(key)) {
          editionMap.set(key, {
            setIdOnchain: setID,
            playIdOnchain: playID,
            setUuid: m.set?.id ?? null,
            playUuid: m.play?.id ?? null,
            playerName: m.play?.stats?.playerName ?? null,
            teamAtMoment: m.play?.stats?.teamAtMoment ?? null,
            setName: m.set?.flowName ?? null,
            series: m.set?.flowSeriesNumber ?? null,
            tier: m.tier ?? null,
            circulationCount: m.setPlay?.circulations?.circulationCount ?? null,
          })
        }
      }

      cursor = nextCursor
      if (!cursor) break

      if (pagesProcessed % 5 === 0) {
        console.log(`[backfill-editions] page ${pagesProcessed}, ${editionMap.size} unique editions so far`)
      }
    }

    editionsFound = editionMap.size
    console.log(`[backfill-editions] Fetched ${editionsFound} unique editions from ${pagesProcessed} pages`)

    // Phase 2: Update editions in Supabase
    // First, find editions missing set_id_onchain
    const { data: missingEditions, error: fetchErr } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .is("set_id_onchain", null)
      .limit(5000)

    if (fetchErr) {
      throw new Error(`Supabase fetch error: ${fetchErr.message}`)
    }

    if (missingEditions && missingEditions.length > 0) {
      for (const edition of missingEditions) {
        const extId = edition.external_id as string
        if (!extId) continue

        // Try to match by integer format "setID:playID"
        const parts = extId.split(":")
        if (parts.length === 2) {
          const leftInt = parseInt(parts[0], 10)
          const rightInt = parseInt(parts[1], 10)

          // Already integer format — use directly
          if (!isNaN(leftInt) && !isNaN(rightInt) && String(leftInt) === parts[0] && String(rightInt) === parts[1]) {
            const { error: updateErr } = await supabaseAdmin
              .from("editions")
              .update({ set_id_onchain: leftInt, play_id_onchain: rightInt })
              .eq("id", edition.id)

            if (!updateErr) editionsUpdated++
            continue
          }

          // UUID format — try to find a matching edition from GQL data
          // Match by UUID set:play → find the edition in our map that has matching UUIDs
          const [setUuid, playUuid] = parts
          for (const [, meta] of editionMap) {
            if (meta.setUuid === setUuid && meta.playUuid === playUuid) {
              const { error: updateErr } = await supabaseAdmin
                .from("editions")
                .update({
                  set_id_onchain: meta.setIdOnchain,
                  play_id_onchain: meta.playIdOnchain,
                })
                .eq("id", edition.id)

              if (!updateErr) editionsUpdated++
              break
            }
          }
        }
      }
    }

    // Phase 3: Upsert any new editions discovered from GQL that aren't in Supabase yet
    const CHUNK = 100
    const entries = Array.from(editionMap.entries())
    let newEditionsUpserted = 0

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK)
      const rows = chunk.map(([key, meta]) => ({
        external_id: key,
        set_id_onchain: meta.setIdOnchain,
        play_id_onchain: meta.playIdOnchain,
      }))

      const { error } = await supabaseAdmin
        .from("editions")
        .upsert(rows, { onConflict: "external_id", ignoreDuplicates: false })

      if (error) {
        console.error("[backfill-editions] Upsert error:", error.message)
      } else {
        newEditionsUpserted += chunk.length
      }
    }

    // Phase 4: Also update sets table where set_id_onchain is null
    const uniqueSets = new Map<string, number>()
    for (const [, meta] of editionMap) {
      if (meta.setUuid) {
        uniqueSets.set(meta.setUuid, meta.setIdOnchain)
      }
    }

    let setsUpdated = 0
    for (const [setUuid, setIdOnchain] of uniqueSets) {
      const { error: setErr } = await supabaseAdmin
        .from("sets")
        .update({ set_id_onchain: setIdOnchain })
        .eq("external_id", setUuid)
        .is("set_id_onchain", null)

      if (!setErr) setsUpdated++
    }

    const durationMs = Date.now() - startTime
    console.log(
      `[backfill-editions] Done — ${pagesProcessed} pages, ${editionsFound} found, ` +
      `${editionsUpdated} existing updated, ${newEditionsUpserted} upserted, ` +
      `${setsUpdated} sets updated in ${durationMs}ms`
    )

    return NextResponse.json({
      ok: true,
      pagesProcessed,
      editionsFound,
      editionsUpdated,
      newEditionsUpserted,
      setsUpdated,
      durationMs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[backfill-editions] Fatal error:", message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        pagesProcessed,
        editionsFound,
        editionsUpdated,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    )
  }
}
