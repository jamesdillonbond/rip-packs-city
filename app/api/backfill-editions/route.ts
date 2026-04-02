import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"

// Query all editions via searchEditions, extracting integer setID/playID
// from the setPlay field (same pattern used in backfill-onchain-ids).
const SEARCH_EDITIONS_QUERY = `
  query SearchAllEditions($cursor: String) {
    searchEditions(
      input: {
        filters: []
        sortBy: { field: ID, direction: DESC }
        pagination: { cursor: $cursor, direction: RIGHT, limit: 100 }
      }
    ) {
      data {
        searchSummary {
          pagination {
            rightCursor
            hasRightCursor
          }
        }
        data {
          ... on EditionSearchResult {
            edition {
              id
              set { id flowID }
              play { id flowID }
            }
          }
        }
      }
    }
  }
`

interface SearchEditionsResponse {
  searchEditions: {
    data: {
      searchSummary: {
        pagination: {
          rightCursor: string | null
          hasRightCursor: boolean
        }
      }
      data: Array<{
        edition: {
          id: string
          set: { id: string; flowID?: number | string }
          play: { id: string; flowID?: number | string }
        }
      }>
    }
  }
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
  let editionsUpserted = 0

  try {
    while (true) {
      const variables: Record<string, unknown> = {}
      if (cursor) variables.cursor = cursor

      const result = await topshotGraphql<SearchEditionsResponse>(
        SEARCH_EDITIONS_QUERY,
        variables
      )

      const searchData = result?.searchEditions?.data
      if (!searchData) {
        console.log("[backfill] No searchData returned, raw result:", JSON.stringify(result).slice(0, 500))
        break
      }

      const editions = searchData.data ?? []
      pagesProcessed++

      // Extract integer setID:playID keys
      const rows: Array<{ external_id: string }> = []
      for (const item of editions) {
        const ed = item?.edition
        if (!ed) continue

        // Try flowID first, fall back to id
        const setID = ed.set?.flowID ?? ed.set?.id
        const playID = ed.play?.flowID ?? ed.play?.id

        if (setID == null || playID == null) continue

        const setInt = parseInt(String(setID), 10)
        const playInt = parseInt(String(playID), 10)

        if (isNaN(setInt) || isNaN(playInt)) continue

        rows.push({ external_id: `${setInt}:${playInt}` })
        editionsFound++
      }

      // Batch upsert in chunks of 100
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100)
        const { error } = await supabaseAdmin
          .from("editions")
          .upsert(chunk, { onConflict: "external_id", ignoreDuplicates: true })

        if (error) {
          console.error("[backfill] Upsert error:", error.message)
        } else {
          editionsUpserted += chunk.length
        }
      }

      if (pagesProcessed % 10 === 0) {
        console.log(`[backfill] page ${pagesProcessed}, ${editionsFound} editions so far`)
      }

      // Check pagination
      const pagination = searchData.searchSummary?.pagination
      if (!pagination?.hasRightCursor || !pagination.rightCursor) {
        break
      }
      cursor = pagination.rightCursor
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[backfill] Fatal error:", message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        pagesProcessed,
        editionsFound,
        editionsUpserted,
        durationMs: Date.now() - startTime,
      },
      { status: 500 }
    )
  }

  const durationMs = Date.now() - startTime
  console.log(`[backfill] Done — ${pagesProcessed} pages, ${editionsFound} found, ${editionsUpserted} upserted in ${durationMs}ms`)

  return NextResponse.json({
    ok: true,
    pagesProcessed,
    editionsFound,
    editionsUpserted,
    durationMs,
  })
}
