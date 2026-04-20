import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── All Day Edition Seed Route ───────────────────────────────────────────────
//
// Fetches all NFL All Day editions from the consumer GQL endpoint (or proxy)
// and upserts them into the editions table with the All Day collection_id.
//
// POST /api/allday-seed-editions  (token-gated)
//
// This is a one-time / periodic bootstrap — populates edition metadata that
// the Flowty-based ingest can't provide (since Flowty has near-zero All Day
// listings). Once editions exist, FMV recalc and listing cache can operate.
// ─────────────────────────────────────────────────────────────────────────────

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

// Prefer the Cloudflare proxy if available; fall back to consumer endpoint
function getGqlUrl(): string {
  if (process.env.AD_PROXY_URL) return process.env.AD_PROXY_URL
  return "https://nflallday.com/consumer/graphql"
}

function gqlHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "sports-collectible-tool/0.1",
  }
  if (process.env.AD_PROXY_URL && process.env.TS_PROXY_SECRET) {
    h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
  }
  return h
}

const EDITIONS_QUERY = `
  query SeedEditions($first: Int!, $after: String) {
    allEditions(first: $first, after: $after) {
      edges {
        node {
          id
          circulationCount
          tier
          series { name number }
          set { name id }
          play {
            id
            playerName
            description
            team { name }
            classification
            gameDate
            awayTeamName
            homeTeamName
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

type GqlEdition = {
  gqlId: string
  circulationCount: number | null
  tier: string
  seriesNumber: number | null
  seriesName: string | null
  setName: string | null
  setId: string | null
  playId: string | null
  playerName: string | null
  teamName: string | null
  playType: string | null
  gameDate: string | null
  homeTeam: string | null
  awayTeam: string | null
}

function normalizeTier(raw: string | null | undefined): string {
  if (!raw) return "COMMON"
  const t = raw.toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  return "COMMON"
}

async function fetchAllEditions(): Promise<GqlEdition[]> {
  const url = getGqlUrl()
  const editions: GqlEdition[] = []
  let after: string | null = null
  let page = 0

  while (true) {
    page++
    const res: Response = await fetch(url, {
      method: "POST",
      headers: gqlHeaders(),
      body: JSON.stringify({
        query: EDITIONS_QUERY,
        variables: { first: 100, after },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GQL HTTP ${res.status}: ${text.slice(0, 300)}`)
    }

    const json: any = await res.json()
    if (json.errors?.length) {
      throw new Error(`GQL errors: ${json.errors.map((e: any) => e.message).join("; ")}`)
    }

    const connection: any = json.data?.allEditions
    if (!connection?.edges) {
      throw new Error("No allEditions.edges in response — check query shape")
    }

    for (const edge of connection.edges) {
      const n = edge.node
      editions.push({
        gqlId: n.id,
        circulationCount: n.circulationCount ?? null,
        tier: normalizeTier(n.tier),
        seriesNumber: n.series?.number ?? null,
        seriesName: n.series?.name ?? null,
        setName: n.set?.name ?? null,
        setId: n.set?.id ?? null,
        playId: n.play?.id ?? null,
        playerName: n.play?.playerName ?? null,
        teamName: n.play?.team?.name ?? null,
        playType: n.play?.classification ?? null,
        gameDate: n.play?.gameDate ?? null,
        homeTeam: n.play?.homeTeamName ?? null,
        awayTeam: n.play?.awayTeamName ?? null,
      })
    }

    console.log(`[allday-seed] page ${page}: ${connection.edges.length} editions (total: ${editions.length})`)

    if (!connection.pageInfo?.hasNextPage) break
    after = connection.pageInfo.endCursor
  }

  return editions
}

function buildEditionKey(ed: GqlEdition): string | null {
  if (ed.setId && ed.playId) return `${ed.setId}:${ed.playId}`
  return ed.gqlId ?? null
}

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_SECRET_TOKEN
  if (!expected) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    )
  }

  const auth = req.headers.get("authorization")
  const token = auth?.replace("Bearer ", "") ?? ""
  if (token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startTime = Date.now()

  try {
    console.log("[allday-seed] Starting edition seed from GQL...")
    console.log("[allday-seed] GQL endpoint:", getGqlUrl())

    const editions = await fetchAllEditions()

    if (editions.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No editions returned from GQL",
        fetched: 0,
        elapsed: Date.now() - startTime,
      })
    }

    // Build tier/series distribution for logging
    const tierCounts: Record<string, number> = {}
    const seriesCounts: Record<string, number> = {}
    for (const ed of editions) {
      tierCounts[ed.tier] = (tierCounts[ed.tier] ?? 0) + 1
      const sKey = ed.seriesName ?? `series_${ed.seriesNumber}`
      seriesCounts[sKey] = (seriesCounts[sKey] ?? 0) + 1
    }
    console.log(`[allday-seed] Fetched ${editions.length} editions — tiers:`, tierCounts, "series:", seriesCounts)

    // Upsert into editions table
    const now = new Date().toISOString()
    const rows = editions
      .map(ed => {
        const externalId = buildEditionKey(ed)
        if (!externalId) return null
        return {
          external_id: externalId,
          collection_id: ALLDAY_COLLECTION_ID,
          collection: "nfl_all_day",
          player_name: ed.playerName ?? null,
          set_name: ed.setName ?? null,
          team_name: ed.teamName ?? null,
          tier: ed.tier,
          series: ed.seriesNumber,
          circulation_count: ed.circulationCount ?? null,
          play_type: ed.playType ?? null,
          game_date: ed.gameDate ?? null,
          home_team: ed.homeTeam ?? null,
          away_team: ed.awayTeam ?? null,
          updated_at: now,
        }
      })
      .filter(Boolean)

    let inserted = 0
    let errors = 0
    const CHUNK = 100

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { error } = await (supabaseAdmin as any)
        .from("editions")
        .upsert(chunk, { onConflict: "external_id,collection_id" })

      if (error) {
        console.error(`[allday-seed] chunk ${i}-${i + chunk.length} error: ${error.message}`)
        // Try one-by-one for this chunk
        for (const row of chunk) {
          const { error: singleErr } = await (supabaseAdmin as any)
            .from("editions")
            .upsert([row], { onConflict: "external_id,collection_id" })
          if (singleErr) {
            console.error(`[allday-seed] bad row ${(row as any).external_id}: ${singleErr.message}`)
            errors++
          } else {
            inserted++
          }
        }
      } else {
        inserted += chunk.length
      }
    }

    console.log(`[allday-seed] Done: ${inserted} upserted, ${errors} errors in ${Date.now() - startTime}ms`)

    return NextResponse.json({
      ok: true,
      fetched: editions.length,
      inserted,
      errors,
      tiers: tierCounts,
      series: seriesCounts,
      elapsed: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[allday-seed] Fatal:", msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
