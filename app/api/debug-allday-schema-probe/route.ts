// app/api/debug-allday-schema-probe/route.ts
// Probe A (round 2). After round 1 confirmed `getMintedMoment` is gone from
// consumer/graphql, this round looks for the replacement that exposes serial
// number per nft_id. Two endpoints + several query shapes per endpoint.
//
// Endpoints:
//   - public-api.nflallday.com/graphql     (sniper-feed hits this directly,
//                                            no proxy, no auth — known good)
//   - nflallday.com/consumer/graphql       (scripts/fetch-allday-collection.mjs
//                                            hits this with searchMomentNFTsV2)
//
// Queries we try, each against both endpoints:
//   1. searchMomentNFTsV2 with `byFlowIDs` filter (most likely candidate)
//   2. searchMomentNFTsV2 with `byNFTFlowIDs` filter (variant)
//   3. searchMomentListings with `byNFTID` (verifies serialNumber in the
//      schema; will only return rows for currently-listed moments, but the
//      404/422 behavior tells us if nft-id filtering is even an option)
//
// Auth: GET ?token=INGEST_SECRET_TOKEN[&nft_id=<id>]
// Default nft_id is 10313674 — same target probe round 1 used.
//
// Response shape: { endpoint, query_name, status, errors[], data sample } per
// probe so the next-step decision is one diff against the responses.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const PUBLIC_API = "https://public-api.nflallday.com/graphql"
const CONSUMER_API = "https://nflallday.com/consumer/graphql"
const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

// Same minimal header set sniper-feed uses against public-api. Consumer/graphql
// accepts the same headers per round 1's probe responses.
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
  return [
    // ── searchMomentNFTsV2 — byFlowIDs filter (the most likely shape) ──────
    {
      name: "publicApi__searchMomentNFTsV2__byFlowIDs",
      endpoint: PUBLIC_API,
      query: `query Q($ids:[String]!){searchMomentNFTsV2(input:{first:5, filters:{byFlowIDs:$ids}}){edges{node{flowID serialNumber editionFlowID}}}}`,
      variables: { ids: [nftId] },
    },
    {
      name: "consumer__searchMomentNFTsV2__byFlowIDs",
      endpoint: CONSUMER_API,
      query: `query Q($ids:[String]!){searchMomentNFTsV2(input:{first:5, filters:{byFlowIDs:$ids}}){edges{node{flowID serialNumber editionFlowID}}}}`,
      variables: { ids: [nftId] },
    },
    // ── searchMomentNFTsV2 — byNFTFlowIDs variant ──────────────────────────
    {
      name: "publicApi__searchMomentNFTsV2__byNFTFlowIDs",
      endpoint: PUBLIC_API,
      query: `query Q($ids:[String]!){searchMomentNFTsV2(input:{first:5, filters:{byNFTFlowIDs:$ids}}){edges{node{flowID serialNumber editionFlowID}}}}`,
      variables: { ids: [nftId] },
    },
    {
      name: "consumer__searchMomentNFTsV2__byNFTFlowIDs",
      endpoint: CONSUMER_API,
      query: `query Q($ids:[String]!){searchMomentNFTsV2(input:{first:5, filters:{byNFTFlowIDs:$ids}}){edges{node{flowID serialNumber editionFlowID}}}}`,
      variables: { ids: [nftId] },
    },
    // ── searchMomentListings byNFTID — sanity check (sniper-feed schema) ──
    {
      name: "publicApi__searchMomentListings__byNFTID",
      endpoint: PUBLIC_API,
      query: `query Q($id:String!){searchMomentListings(input:{filters:{byNFTID:$id}, searchInput:{pagination:{cursor:"", direction:RIGHT, limit:5}}}){data{searchSummary{data{... on MomentListings{data{... on MomentListing{id serialNumber}}}}}}}}`,
      variables: { id: nftId },
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
