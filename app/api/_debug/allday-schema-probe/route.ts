// app/api/_debug/allday-schema-probe/route.ts
// Probe A. Diagnoses why getMintedMoment 422s on the worker path despite five
// existing repo callers (lib/alldayGraphql.ts, allday-wallet-search/route.ts,
// allday-sets/route.ts, the two backfill scripts) being written as if it
// works on nflallday.com/consumer/graphql.
//
// Hits consumer/graphql DIRECTLY from Vercel egress — no proxy worker —
// using the same Content-Type + User-Agent header set lib/alldayGraphql.ts
// uses. Three queries fired in parallel:
//   1. getMintedMoment with the union fragment (worker path uses this for TS).
//   2. getMintedMoment with direct selection (worker path uses this for AllDay).
//   3. __schema introspection — names of every Query field actually exposed.
//
// The introspection result is the tiebreaker: if `getMintedMoment` shows up
// in the field list, the schema has it and we have a header/cookie/IP problem
// (compare Vercel egress vs Cloudflare worker egress). If it's missing, the
// existing callers have been silently broken since the schema dropped the
// field, and we need to find where flowSerialNumber lives now.
//
// Auth: GET ?token=INGEST_SECRET_TOKEN[&nft_id=<id>]
// Default nft_id is 10313674 — same target the v6 worker probe failed on.
//
// Delete this route once Track 1 commits and the AllDay backfill is wired up
// against the right operation. It's a one-shot diagnostic.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const ALLDAY_CONSUMER_GRAPHQL_URL = "https://nflallday.com/consumer/graphql"
const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

// Same query shape the worker path sends for TopShot — `data` as a union.
const QUERY_GET_MINTED_UNION =
  `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber}}}}`

// Same query shape the worker path sends for AllDay — `data` as direct type.
const QUERY_GET_MINTED_DIRECT =
  `query($id:ID!){getMintedMoment(momentId:$id){data{flowSerialNumber}}}`

// Minimal introspection — names of every top-level Query field.
const QUERY_INTROSPECT = `{__schema{queryType{fields{name}}}}`

interface ProbeResult {
  ok: boolean
  status: number
  elapsed_ms: number
  response_headers?: Record<string, string>
  body_snippet?: string
  parsed?: unknown
  error?: string
}

async function postGql(query: string, variables?: Record<string, unknown>): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const res = await fetch(ALLDAY_CONSUMER_GRAPHQL_URL, {
      method: "POST",
      headers: {
        // Identical header set to lib/alldayGraphql.ts. NOT adding Origin /
        // Referer / browser UA here — the whole point of this probe is to
        // measure what the existing-caller header set actually returns.
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    })
    const bodyText = await res.text()
    let parsed: unknown = null
    try { parsed = JSON.parse(bodyText) } catch { /* leave as text */ }
    return {
      ok: res.ok,
      status: res.status,
      elapsed_ms: Date.now() - startedAt,
      response_headers: Object.fromEntries(res.headers.entries()),
      body_snippet: bodyText.slice(0, 2500),
      parsed,
    }
  } catch (err) {
    return {
      ok: false,
      status: -1,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const nftId = req.nextUrl.searchParams.get("nft_id") ?? "10313674"

  const [unionResult, directResult, introspectionResult] = await Promise.all([
    postGql(QUERY_GET_MINTED_UNION, { id: nftId }),
    postGql(QUERY_GET_MINTED_DIRECT, { id: nftId }),
    postGql(QUERY_INTROSPECT),
  ])

  // Surface the most-relevant slice of the introspection result. If the
  // upstream returns a full field list, dig out names matching the moment /
  // edition / serial vocabulary — that's the candidate-replacement set if
  // getMintedMoment is gone.
  let allFieldNames: string[] | null = null
  let candidateFields: string[] | null = null
  try {
    const fields = (((introspectionResult.parsed as any)?.data?.__schema?.queryType?.fields) ?? []) as Array<{ name?: string }>
    allFieldNames = fields.map((f) => String(f?.name ?? "")).filter(Boolean)
    candidateFields = allFieldNames.filter((n) =>
      /moment|minted|edition|serial|search|byid/i.test(n)
    )
  } catch { /* ignore parse errors — body_snippet has the raw payload */ }

  return NextResponse.json({
    upstream: ALLDAY_CONSUMER_GRAPHQL_URL,
    nft_id: nftId,
    headers_sent: {
      "Content-Type": "application/json",
      "User-Agent": "sports-collectible-tool/0.1",
    },
    probes: {
      getMintedMoment_union_form:  unionResult,
      getMintedMoment_direct_form: directResult,
      introspection: {
        ...introspectionResult,
        field_count: allFieldNames?.length ?? null,
        candidate_fields: candidateFields,
        // Only return the full list if it's small enough to be useful; large
        // schemas should be inspected via candidate_fields + body_snippet.
        all_field_names: allFieldNames && allFieldNames.length <= 250 ? allFieldNames : null,
      },
    },
  })
}
