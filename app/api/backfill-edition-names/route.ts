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
query SearchMarketplaceEditions(
  $byEditions: [EditionsFilterInput] = []
  $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 1, cursor: ""}}
) {
  searchMarketplaceEditions(input: {
    filters: { byEditions: $byEditions }
    sortBy: EDITION_CREATED_AT_DESC
    searchInput: $searchInput
  }) {
    data {
      searchSummary {
        data {
          data {
            ... on MarketplaceEdition {
              tier
              set { flowName flowSeriesNumber __typename }
              play { stats { playerName teamAtMoment __typename } __typename }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
  }
}
`

type EditionResult = {
  externalId: string
  name: string | null
  tier: string | null
  series: number | null
  error?: string
}

function cleanTier(raw: string | null): string | null {
  if (!raw) return null
  return raw.replace(/^MOMENT_TIER_/, "").toLowerCase()
    .replace(/^./, function (c) { return c.toUpperCase() })
}

async function fetchEditionInfo(setId: string, playId: string): Promise<EditionResult> {
  const ek = setId + ":" + playId
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        query: EDITION_QUERY,
        variables: {
          byEditions: [{ setID: String(setId), playID: String(playId) }],
          searchInput: { pagination: { direction: "RIGHT", limit: 1, cursor: "" } },
        },
      }),
      cache: "no-store" as RequestCache,
      signal: AbortSignal.timeout(8000),
    })
    const rawText = await res.text()
    if (!res.ok) {
      return { externalId: ek, name: null, tier: null, series: null, error: "HTTP " + res.status + " body:" + rawText.substring(0, 500) }
    }
    let json: any
    try { json = JSON.parse(rawText) } catch {
      return { externalId: ek, name: null, tier: null, series: null, error: "JSON parse failed: " + rawText.substring(0, 300) }
    }
    if (json.errors?.length) {
      return { externalId: ek, name: null, tier: null, series: null, error: "GQL error: " + json.errors[0].message }
    }
    const edArr = json?.data?.searchMarketplaceEditions?.data?.searchSummary?.data?.data
    if (!edArr?.length) {
      return { externalId: ek, name: null, tier: null, series: null, error: "no editions returned" }
    }
    const ed = edArr[0]
    const playerName = ed.play?.stats?.playerName || ""
    const setName = ed.set?.flowName || ""
    const tier = cleanTier(ed.tier)
    const series = ed.set?.flowSeriesNumber != null ? Number(ed.set.flowSeriesNumber) : null
    if (!playerName) {
      return { externalId: ek, name: null, tier: null, series: null, error: "no playerName in response" }
    }
    return {
      externalId: ek,
      name: playerName + " — " + (setName || "Unknown Set"),
      tier,
      series,
    }
  } catch (err) {
    return { externalId: ek, name: null, tier: null, series: null, error: err instanceof Error ? err.message : String(err) }
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
  const sampleErrors: string[] = []

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
      if (!r.info.name) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(r.externalId + ": " + (r.info.error || "unknown"))
        }
        continue
      }
      const { error: upErr } = await (supabaseAdmin as any)
        .from("editions")
        .update({ name: r.info.name, tier: r.info.tier, series: r.info.series })
        .eq("id", r.id)
      if (upErr) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(r.externalId + ": db update — " + upErr.message)
        }
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

  return NextResponse.json({ ok: true, updated, failed, remaining: remaining ?? 0, sample_errors: sampleErrors })
}
