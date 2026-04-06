import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/backfill-edition-names
 *
 * Backfills stub editions (external_id like "setId:playId", name IS NULL)
 * with player name, set name, tier, and series from the Top Shot GQL API.
 * Auth: Bearer INGEST_SECRET_TOKEN. Processes up to 200 per run.
 */

export const maxDuration = 60

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql"
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

const EDITION_QUERY = `
query($setIDs: [ID], $playIDs: [ID]) {
  searchEditions(input: { filters: { bySetIDs: $setIDs, byPlayIDs: $playIDs } }) {
    searchSummary { data { ... on Editions { size } } }
    data {
      ... on Editions {
        edges {
          node {
            id
            tier
            set { flowName }
            play { stats { playerName fullName } }
            assetPathPrefix
            flowSeriesNumber
          }
        }
      }
    }
  }
}
`

type EditionResult = {
  externalId: string
  name: string | null
  tier: string | null
  series: number | null
}

async function fetchEditionInfo(setId: string, playId: string): Promise<EditionResult | null> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        query: EDITION_QUERY,
        variables: { setIDs: [setId], playIDs: [playId] },
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = await res.json()
    const edges = json?.data?.searchEditions?.data?.edges
    if (!edges?.length) return null
    const node = edges[0].node
    const playerName = node.play?.stats?.playerName || node.play?.stats?.fullName || ""
    const setName = node.set?.flowName || ""
    const tier = node.tier || null
    const series = node.flowSeriesNumber != null ? Number(node.flowSeriesNumber) : null
    if (!playerName) return null
    return {
      externalId: setId + ":" + playId,
      name: playerName + " — " + (setName || "Unknown Set"),
      tier,
      series,
    }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== "Bearer " + process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // Find stub editions: external_id matches "digits:digits" and name is null
  const { data: stubs, error: queryErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id")
    .is("name", null)
    .like("external_id", "%:%")
    .limit(200)

  if (queryErr) {
    return NextResponse.json({ error: "query error: " + queryErr.message }, { status: 500 })
  }

  // Filter to only integer:integer format
  const editionsToFill = (stubs ?? []).filter(function (e: any) {
    return /^\d+:\d+$/.test(e.external_id)
  })

  if (editionsToFill.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, failed: 0, remaining: 0 })
  }

  let updated = 0
  let failed = 0

  // Process in batches of 10 concurrent
  for (let i = 0; i < editionsToFill.length; i += 10) {
    const batch = editionsToFill.slice(i, i + 10)
    const results = await Promise.all(
      batch.map(function (e: any) {
        const [setId, playId] = e.external_id.split(":")
        return fetchEditionInfo(setId, playId).then(function (info) {
          return { id: e.id, externalId: e.external_id, info }
        })
      })
    )

    for (const r of results) {
      if (!r.info) { failed++; continue }
      const { error: upErr } = await (supabaseAdmin as any)
        .from("editions")
        .update({ name: r.info.name, tier: r.info.tier, series: r.info.series })
        .eq("id", r.id)
      if (upErr) {
        failed++
        console.log("[backfill-edition-names] update error for " + r.externalId + ": " + upErr.message)
      } else {
        updated++
      }
    }
  }

  // Count remaining stubs
  const { count: remaining } = await (supabaseAdmin as any)
    .from("editions")
    .select("id", { count: "exact", head: true })
    .is("name", null)
    .like("external_id", "%:%")

  return NextResponse.json({ ok: true, updated, failed, remaining: remaining ?? 0 })
}
