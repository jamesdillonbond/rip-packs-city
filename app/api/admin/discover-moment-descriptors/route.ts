// app/api/admin/discover-moment-descriptors/route.ts
//
// ONE-SHOT DISCOVERY PROBE — does the upstream expose the descriptive text the
// Top Shot site shows on a moment page, and is it populated?
//
// WHY THIS EXISTS. The Top Shot moment page renders a headline ("Victor
// Wembanyama stuffs stat sheet in historic 5x5 vs Lakers"), a prose paragraph,
// and a full per-moment box score. NONE of that is in our catalog: `editions`
// has no description column, `editions.name` is just "<Player> — <Set>", and
// play_type/play_category are shot mechanics. That gap is the single thing
// standing between our catalog search and an actual moment encyclopedia — a
// query like "game winner" is unanswerable today because the CONCEPT is absent
// from our data, not because the query is wrong.
//
// It runs as a route rather than a script because the Cloudflare-proxied
// Top Shot/AllDay GraphQL needs TS_PROXY_SECRET, which exists only in the
// Vercel environment — the dev sandbox has no secrets and cannot reach the
// upstream at all. Same reasoning as the staged golazos-offers-indexer probe.
//
// WHAT IT ALREADY KNOWS (verified in-repo, 2026-08-11):
//   · AllDay — lib/chains/flow/editions-hydrate.ts ALREADY SELECTS
//     `play { description }` in its live seed query, but the mapper keeps only
//     `classification` as play_type. So we have been FETCHING a description
//     field and throwing it away on every run. Whether it is POPULATED is the
//     open question, which is why this probe returns sample values, not just
//     field names.
//   · Top Shot — we select `play { stats { playerName, playCategory, playType,
//     dateOfMoment, teamAtMoment, … } }` and no descriptive field at all. The
//     site clearly has more; the probe walks candidates to find out what.
//
// METHOD. Introspection first (cheap and complete when the upstream allows it).
// If introspection is disabled — common on public gateways — it falls back to
// FIELD PROBING: ask for one candidate field at a time and read the error.
// GraphQL answers "Cannot query field X on type Y" for a field that does not
// exist and returns data for one that does, so the error text is itself the
// schema. Every probe is a bounded, read-only query.
//
// This route WRITES NOTHING. It reports. Acting on the result is a separate,
// reviewable change.
//
//   curl -s -X POST https://www.rippackscity.com/api/admin/discover-moment-descriptors \
//     -H "Authorization: Bearer $RPC_ADMIN_TOKEN" | jq

import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

// Candidate descriptive fields on the Top Shot `PlayStats` type. Drawn from
// what the moment page visibly renders (headline, prose, box score, bio).
const TOPSHOT_STATS_CANDIDATES = [
  // headline / prose
  "description", "headline", "title", "subtitle", "caption", "summary",
  "playSummary", "momentDescription",
  // box score — the numbers under "Highlight stats"
  "points", "rebounds", "assists", "steals", "blocks", "turnovers",
  "minutes", "fieldGoalsMade", "fieldGoalsAttempted", "threePointersMade",
  "threePointersAttempted", "freeThrowsMade", "freeThrowsAttempted",
  "plusMinus",
  // game context — the scoreboard row
  "homeTeamName", "awayTeamName", "homeTeamScore", "awayTeamScore",
  "nbaSeason", "dateOfMoment", "quarter", "gameId",
  // player bio — the "Player details" card
  "height", "weight", "birthdate", "birthplace", "currentTeamId",
  "draftYear", "draftRound", "draftPick", "position", "jerseyNumber",
]

// Candidate fields directly on the Top Shot `Play` type (not under stats).
const TOPSHOT_PLAY_CANDIDATES = ["description", "headline", "title", "summary", "assetPathPrefix"]

// AllDay's `play` already accepts `description` in our live query; these are
// the neighbours worth confirming in the same pass.
const ALLDAY_PLAY_CANDIDATES = [
  "description", "headline", "title", "classification", "playType",
  "gameDate", "homeTeamName", "awayTeamName", "homeTeamScore", "awayTeamScore",
  "week", "season", "quarter", "yards", "playerPosition",
]

const INTROSPECT = `
  query T($name: String!) {
    __type(name: $name) {
      name
      fields { name description type { name kind ofType { name kind } } }
    }
  }
`

interface ProbeResult {
  field: string
  exists: boolean
  sample?: unknown
  error?: string
}

function proxyUrl(path: string): string | null {
  const base = process.env.TS_PROXY_URL || process.env.TOPSHOT_PROXY_URL
  if (!base) return null
  return base.replace(/\/+$/, "") + path
}

async function gql(
  path: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data?: any; errors?: Array<{ message: string }>; transport?: string }> {
  const url = proxyUrl(path)
  const secret = process.env.TS_PROXY_SECRET
  if (!url || !secret) return { transport: "missing TS_PROXY_URL or TS_PROXY_SECRET" }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Proxy-Secret": secret },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return { transport: `HTTP ${res.status}` }
    return (await res.json()) as any
  } catch (e) {
    return { transport: e instanceof Error ? e.message : "fetch failed" }
  }
}

/** Try introspection on a named type. Returns null when it is disabled. */
async function introspect(path: string, typeName: string) {
  const r = await gql(path, INTROSPECT, { name: typeName })
  const fields = r?.data?.__type?.fields
  if (!Array.isArray(fields)) return null
  return fields.map((f: any) => ({
    name: f.name,
    description: f.description ?? null,
    type: f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind ?? null,
  }))
}

/**
 * Probe one candidate field by asking for it and reading the error. A
 * GraphQL server answers "Cannot query field X on type Y" for an unknown
 * field, so a failed probe is as informative as a successful one.
 */
async function probeField(
  path: string,
  buildQuery: (field: string) => string,
  variables: Record<string, unknown>,
  field: string,
  pluck: (data: any) => unknown
): Promise<ProbeResult> {
  const r = await gql(path, buildQuery(field), variables)
  if (r.transport) return { field, exists: false, error: r.transport }
  const err = r.errors?.[0]?.message
  if (err && /cannot query field|unknown field|doesn't exist|has no field/i.test(err)) {
    return { field, exists: false }
  }
  if (err) return { field, exists: false, error: err.slice(0, 180) }
  let sample: unknown
  try { sample = pluck(r.data) } catch { sample = undefined }
  if (typeof sample === "string" && sample.length > 400) sample = sample.slice(0, 400) + "…"
  return { field, exists: true, sample }
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

export async function POST(req: NextRequest) {
  const admin = process.env.RPC_ADMIN_TOKEN
  const ingest = process.env.INGEST_SECRET_TOKEN
  const auth = req.headers.get("authorization") ?? ""
  const ok =
    (admin && auth === `Bearer ${admin}`) || (ingest && auth === `Bearer ${ingest}`)
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  // Defaults are the Wembanyama 5x5 moment from the reference screenshots, so
  // the probe's sample values can be eyeballed against a page we have seen.
  const setID = sp.get("setID") ?? ""
  const playID = sp.get("playID") ?? ""

  const report: Record<string, unknown> = {
    ran_at: new Date().toISOString(),
    note:
      "Read-only schema discovery. Reports which descriptive fields the upstream exposes and whether they are populated. Writes nothing.",
    inputs: { setID: setID || "(none — set ?setID=&playID= for richer samples)", playID: playID || "(none)" },
  }

  // ── Top Shot ──────────────────────────────────────────────────────────────
  const tsIntrospection = {
    PlayStats: await introspect("/topshot", "PlayStats"),
    Play: await introspect("/topshot", "Play"),
    MintedMoment: await introspect("/topshot", "MintedMoment"),
  }
  report.topshot_introspection = tsIntrospection

  const tsArgs = setID && playID
    ? { setID, playID, first: 1 }
    : { setID: null as string | null, playID: null as string | null, first: 1 }

  // If introspection worked we do not need to brute-force; probing is the
  // fallback, and saying which path produced the answer keeps the report honest.
  if (!tsIntrospection.PlayStats) {
    report.topshot_stats_probe = await inBatches(TOPSHOT_STATS_CANDIDATES, 4, (f) =>
      probeField(
        "/topshot",
        (field) => `
          query P($setID: ID, $playID: ID, $first: Int!) {
            searchEditions(input: { setID: $setID, playID: $playID, first: $first }) {
              data { play { stats { ${field} } } }
            }
          }`,
        tsArgs,
        f,
        (d) => d?.searchEditions?.data?.[0]?.play?.stats?.[f]
      )
    )
    report.topshot_play_probe = await inBatches(TOPSHOT_PLAY_CANDIDATES, 4, (f) =>
      probeField(
        "/topshot",
        (field) => `
          query P($setID: ID, $playID: ID, $first: Int!) {
            searchEditions(input: { setID: $setID, playID: $playID, first: $first }) {
              data { play { ${field} } }
            }
          }`,
        tsArgs,
        f,
        (d) => d?.searchEditions?.data?.[0]?.play?.[f]
      )
    )
  } else {
    report.topshot_stats_probe = "skipped — introspection succeeded, read topshot_introspection.PlayStats"
  }

  // ── All Day ───────────────────────────────────────────────────────────────
  // We already select play.description here and discard it; confirm it is
  // populated before anyone builds on it.
  const adIntrospection = await introspect("/allday", "Play")
  report.allday_introspection = adIntrospection

  report.allday_play_probe = await inBatches(ALLDAY_PLAY_CANDIDATES, 4, (f) =>
    probeField(
      "/allday",
      (field) => `
        query P($first: Int!) {
          allEditions(first: $first) {
            edges { node { play { ${field} } } }
          }
        }`,
      { first: 1 },
      f,
      (d) => d?.allEditions?.edges?.[0]?.node?.play?.[f]
    )
  )

  // ── Verdict ───────────────────────────────────────────────────────────────
  const adDesc = (report.allday_play_probe as ProbeResult[])?.find?.((p) => p.field === "description")
  report.verdict = {
    allday_description_exists: adDesc?.exists ?? null,
    allday_description_populated:
      typeof adDesc?.sample === "string" && adDesc.sample.trim().length > 0,
    allday_description_sample: adDesc?.sample ?? null,
    next_step:
      "If a descriptive field exists AND is populated, the follow-up is: add editions.description (+ headline), capture it in the ingest that already fetches it, and extend rpc_search_catalog's edition arm to search it. Until then a narrative search query correctly returns nothing.",
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } })
}
