// app/api/debug-allday-schema-probe/route.ts
// Probe A (round 3). Round 2 confirmed:
//   - public-api.nflallday.com/graphql nginx-404s our queries (not the path)
//   - consumer/graphql HAS searchMomentNFTsV2 with `MomentNFTFilters` whitelisting
//     bySetFlowIDs | byFlowIDs | byPlayFlowIDs | byFlowIDsV2
//   - byFlowIDs accepts [Int], not [String]
//
// This round confirms the byFlowIDs([Int]) path actually returns serialNumber,
// and compares byFlowIDs vs byFlowIDsV2 head-to-head so we pick the right one.
// Selection set is expanded — extra fields cost nothing if accepted, and any
// "Cannot query field" rejections document the schema for free.
//
// Auth: GET ?token=INGEST_SECRET_TOKEN[&nft_id=<id>]

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const CONSUMER_API = "https://nflallday.com/consumer/graphql"
const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

interface Probe {
  name: string
  endpoint: string
  query: string
  variables?: Record<string, unknown>
}

function buildProbes(nftId: string): Probe[] {
  // Try the same selection set on both filter variants. Selection set includes
  // a few extra fields beyond the minimum we need (flowID + serialNumber) so
  // the schema's response shape is captured here as documentation.
  const SELECTION_SET = `
    edges {
      node {
        flowID
        serialNumber
        editionFlowID
        edition {
          tier
          set { flowID name }
          play { id metadata { playerFullName teamName } }
        }
      }
    }
  `
  const idAsInt = Number(nftId)

  return [
    {
      name: "consumer__searchMomentNFTsV2__byFlowIDs__intArray",
      endpoint: CONSUMER_API,
      query: `query Q($ids:[Int]!){searchMomentNFTsV2(input:{first:5, filters:{byFlowIDs:$ids}}){${SELECTION_SET}}}`,
      variables: { ids: [idAsInt] },
    },
    {
      name: "consumer__searchMomentNFTsV2__byFlowIDsV2__intArray",
      endpoint: CONSUMER_API,
      query: `query Q($ids:[Int]!){searchMomentNFTsV2(input:{first:5, filters:{byFlowIDsV2:$ids}}){${SELECTION_SET}}}`,
      variables: { ids: [idAsInt] },
    },
    // Defensive: also try byFlowIDsV2 with [String] in case V2 is "newer, less
    // restrictive" and accepts strings — explicit hypothesis test, not a guess.
    {
      name: "consumer__searchMomentNFTsV2__byFlowIDsV2__stringArray",
      endpoint: CONSUMER_API,
      query: `query Q($ids:[String]!){searchMomentNFTsV2(input:{first:5, filters:{byFlowIDsV2:$ids}}){${SELECTION_SET}}}`,
      variables: { ids: [String(nftId)] },
    },
  ]
}

interface ProbeResult {
  name: string
  endpoint: string
  status: number
  elapsed_ms: number
  errors?: Array<{ message?: string }>
  data_sample?: unknown
  body_snippet?: string
  network_error?: string
}

async function runProbe(p: Probe): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await fetch(p.endpoint, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify({ query: p.query, variables: p.variables ?? {} }),
      cache: "no-store",
    })
    const text = await res.text()
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch { /* leave as text */ }
    return {
      name: p.name,
      endpoint: p.endpoint,
      status: res.status,
      elapsed_ms: Date.now() - startedAt,
      errors: parsed?.errors,
      data_sample: parsed?.data ?? null,
      body_snippet: parsed ? undefined : text.slice(0, 600),
    }
  } catch (err) {
    return {
      name: p.name,
      endpoint: p.endpoint,
      status: -1,
      elapsed_ms: Date.now() - startedAt,
      network_error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const nftId = req.nextUrl.searchParams.get("nft_id") ?? "10313674"
  const probes = buildProbes(nftId)
  const results = await Promise.all(probes.map(runProbe))
  return NextResponse.json({
    nft_id: nftId,
    headers_sent: BASE_HEADERS,
    results,
  })
}
