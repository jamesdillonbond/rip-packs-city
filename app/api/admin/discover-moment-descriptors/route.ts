// app/api/admin/discover-moment-descriptors/route.ts
//
// ONE-SHOT DISCOVERY PROBE — does the upstream expose the descriptive text the
// Top Shot moment page shows (headline, prose paragraph, per-moment box score),
// and is it populated?
//
// WHY THIS EXISTS. The Top Shot moment page renders a headline ("Victor
// Wembanyama stuffs stat sheet in historic 5x5 vs Lakers"), a prose paragraph,
// and a full box score. None of that is in our catalog, which is exactly why a
// narrative search ("game winner", "buzzer beater") matches nothing — the
// CONCEPT is absent from our data. It runs as a route because the upstream is
// Cloudflare-proxied and needs TS_PROXY_SECRET, which exists only in Vercel;
// the dev sandbox holds no secrets and cannot reach either upstream at all
// (measured: curl to both returns status=000).
//
// ─────────────────────────────────────────────────────────────────────────────
// V2, AFTER V1 PRODUCED A FALSE NEGATIVE (2026-08-11). Read this before
// trusting any output.
//
// V1 reported `exists: false` for EVERY field on both leagues. That was wrong,
// and its own data proved it: it marked `classification`, `gameDate`,
// `homeTeamName` and `dateOfMoment` as non-existent — all four are in our LIVE
// production ingest queries and work every day. What actually happened was two
// transport failures that V1 rendered as schema facts:
//   · AllDay 404 — V1 posted to `${TS_PROXY_URL}/allday`, but the AllDay
//     ingest resolves `ALLDAY_PROXY_URL` (default nflallday.com/consumer/graphql).
//     Wrong endpoint, so every field 404'd.
//   · Top Shot 422 — V1 passed `setID: null, playID: null` into searchEditions.
//     Top Shot answers HTTP 422 for an invalid QUERY (documented in CLAUDE.md
//     re: topshotScore), so every field 422'd regardless of whether it exists.
//
// The root design flaw was having NO CONTROL: with nothing known-good probed
// alongside, a blanket failure is indistinguishable from a blanket "absent".
// V2 fixes that structurally:
//   1. `status` is "yes" | "no" | "unknown" — a transport failure is NEVER "no".
//   2. Every league probes CONTROL fields we already query in production. If a
//      control does not come back "yes", the whole arm is reported INCONCLUSIVE
//      and its per-field results are explicitly not to be trusted.
//   3. Error BODIES are captured (truncated), because Top Shot's 422 body
//      carries the GraphQL message naming the offending field — that message is
//      the actual schema signal.
//   4. Endpoints mirror the production resolvers rather than being guessed.
//
// This route WRITES NOTHING.
//
//   curl -s -X POST https://www.rippackscity.com/api/admin/discover-moment-descriptors \
//     -H "Authorization: Bearer $RPC_ADMIN_TOKEN" -o descriptors.json \
//     -w "http_status=%{http_code}\n"

import { NextRequest, NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120

type Status = "yes" | "no" | "unknown"

interface ProbeResult {
  field: string
  status: Status
  sample?: unknown
  detail?: string
}

// Fields we ALREADY query in production, so they must come back "yes". If they
// don't, the transport is broken and nothing else in that arm means anything.
const TOPSHOT_STATS_CONTROLS = ["playerName", "playCategory", "dateOfMoment"]
const ALLDAY_PLAY_CONTROLS = ["playerName", "classification"]

const TOPSHOT_STATS_CANDIDATES = [
  "description", "headline", "title", "subtitle", "caption", "summary",
  "playSummary", "momentDescription", "playDescription",
  "points", "rebounds", "assists", "steals", "blocks", "turnovers",
  "minutes", "fieldGoalsMade", "threePointersMade", "freeThrowsMade", "plusMinus",
  "homeTeamName", "awayTeamName", "homeTeamScore", "awayTeamScore",
  "nbaSeason", "quarter", "gameId", "gameDate",
  "height", "weight", "birthdate", "birthplace",
  "draftYear", "draftRound", "draftPick", "position", "jerseyNumber",
]

const TOPSHOT_PLAY_CANDIDATES = ["description", "headline", "title", "summary", "statsValues"]

const ALLDAY_PLAY_CANDIDATES = [
  "description", "headline", "title", "playType", "gameDate",
  "homeTeamName", "awayTeamName", "homeTeamScore", "awayTeamScore",
  "week", "season", "quarter", "yards", "playerPosition", "stats",
]

/** Top Shot: the worker root IS the Top Shot endpoint (see editions-hydrate). */
function topshotUrl(): string | null {
  return process.env.TS_PROXY_URL || null
}

/**
 * All Day: mirror lib/editions-hydrate.ts exactly — ALLDAY_PROXY_URL, falling
 * back to the consumer endpoint. V1 guessed `${TS_PROXY_URL}/allday` and 404'd
 * every probe.
 */
function alldayUrl(): string | null {
  return process.env.ALLDAY_PROXY_URL || "https://nflallday.com/consumer/graphql"
}

async function gql(
  url: string | null,
  query: string,
  variables: Record<string, unknown>,
  withSecret: boolean
): Promise<{ data?: any; errors?: Array<{ message: string }>; transport?: string }> {
  const secret = process.env.TS_PROXY_SECRET
  if (!url) return { transport: "no endpoint configured" }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/descriptor-probe",
  }
  if (withSecret && secret) headers["X-Proxy-Secret"] = secret
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) })
    const text = await res.text()
    if (!res.ok) {
      // The BODY is the diagnostic: Top Shot's 422 names the offending field.
      return { transport: `HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    try {
      return JSON.parse(text)
    } catch {
      return { transport: `unparseable body: ${text.slice(0, 200)}` }
    }
  } catch (e) {
    return { transport: e instanceof Error ? e.message : "fetch failed" }
  }
}

/** Does this message name a field the schema does not have? */
function isUnknownFieldError(msg: string): boolean {
  return /cannot query field|unknown field|doesn't exist|has no field|did you mean|not defined on type/i.test(msg)
}

async function probeField(
  url: string | null,
  buildQuery: (field: string) => string,
  variables: Record<string, unknown>,
  field: string,
  pluck: (data: any) => unknown,
  withSecret: boolean
): Promise<ProbeResult> {
  const r = await gql(url, buildQuery(field), variables, withSecret)

  if (r.transport) {
    // A transport failure says NOTHING about the schema — unless the body
    // itself names the field as unknown, which is how Top Shot reports it.
    if (isUnknownFieldError(r.transport)) {
      return { field, status: "no", detail: r.transport.slice(0, 200) }
    }
    return { field, status: "unknown", detail: r.transport.slice(0, 200) }
  }

  const err = r.errors?.[0]?.message
  if (err && isUnknownFieldError(err)) return { field, status: "no", detail: err.slice(0, 200) }
  if (err) return { field, status: "unknown", detail: err.slice(0, 200) }

  let sample: unknown
  try { sample = pluck(r.data) } catch { sample = undefined }
  if (typeof sample === "string" && sample.length > 400) sample = sample.slice(0, 400) + "…"
  return { field, status: "yes", sample }
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

/** An arm is only trustworthy when every control came back "yes". */
function summarize(controls: ProbeResult[], probes: ProbeResult[]) {
  const passed = controls.filter((c) => c.status === "yes").map((c) => c.field)
  const failed = controls.filter((c) => c.status !== "yes")
  const conclusive = failed.length === 0
  return {
    conclusive,
    controls_passed: passed,
    controls_failed: failed,
    warning: conclusive
      ? null
      : "INCONCLUSIVE — control fields we query in production did not resolve, so the transport or query shape is wrong. The per-field results below are NOT evidence that anything is absent. Fix the transport and re-run.",
    found: conclusive ? probes.filter((p) => p.status === "yes").map((p) => ({ field: p.field, sample: p.sample })) : [],
    absent: conclusive ? probes.filter((p) => p.status === "no").map((p) => p.field) : [],
    indeterminate: probes.filter((p) => p.status === "unknown").map((p) => p.field),
  }
}

export async function POST(req: NextRequest) {
  const admin = process.env.RPC_ADMIN_TOKEN
  const ingest = process.env.INGEST_SECRET_TOKEN
  const auth = req.headers.get("authorization") ?? ""
  const ok = (admin && auth === `Bearer ${admin}`) || (ingest && auth === `Bearer ${ingest}`)
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const setID = sp.get("setID")
  const playID = sp.get("playID")

  const report: Record<string, unknown> = {
    ran_at: new Date().toISOString(),
    probe_version: 2,
    note:
      "Read-only schema discovery. status is yes|no|unknown — a transport failure is never 'no'. Each arm carries CONTROL fields we query in production; if a control fails the arm is INCONCLUSIVE and its results prove nothing.",
    endpoints: {
      topshot: topshotUrl() ? "TS_PROXY_URL (set)" : "TS_PROXY_URL MISSING",
      allday: process.env.ALLDAY_PROXY_URL ? "ALLDAY_PROXY_URL (set)" : "ALLDAY_PROXY_URL unset — using nflallday.com/consumer/graphql",
      secret: process.env.TS_PROXY_SECRET ? "TS_PROXY_SECRET (set)" : "TS_PROXY_SECRET MISSING",
    },
  }

  // ── Top Shot ──────────────────────────────────────────────────────────────
  // No null setID/playID: that shape is what made V1 422 on every field.
  const tsInput = setID && playID
    ? `input: { setID: "${setID.replace(/"/g, "")}", playID: "${playID.replace(/"/g, "")}", first: 1 }`
    : `input: { first: 1 }`

  const tsStatsQuery = (field: string) => `
    query { searchEditions(${tsInput}) { data { play { stats { ${field} } } } } }`
  const tsPlayQuery = (field: string) => `
    query { searchEditions(${tsInput}) { data { play { ${field} } } } }`
  const tsStatsPluck = (f: string) => (d: any) => d?.searchEditions?.data?.[0]?.play?.stats?.[f]
  const tsPlayPluck = (f: string) => (d: any) => d?.searchEditions?.data?.[0]?.play?.[f]

  const tsControls = await inBatches(TOPSHOT_STATS_CONTROLS, 3, (f) =>
    probeField(topshotUrl(), tsStatsQuery, {}, f, tsStatsPluck(f), true)
  )
  const tsStats = await inBatches(TOPSHOT_STATS_CANDIDATES, 4, (f) =>
    probeField(topshotUrl(), tsStatsQuery, {}, f, tsStatsPluck(f), true)
  )
  const tsPlay = await inBatches(TOPSHOT_PLAY_CANDIDATES, 4, (f) =>
    probeField(topshotUrl(), tsPlayQuery, {}, f, tsPlayPluck(f), true)
  )

  report.topshot = {
    ...summarize(tsControls, [...tsStats, ...tsPlay]),
    control_detail: tsControls,
    stats_probe: tsStats,
    play_probe: tsPlay,
  }

  // ── All Day ───────────────────────────────────────────────────────────────
  const adQuery = (field: string) => `
    query { allEditions(first: 1) { edges { node { play { ${field} } } } } }`
  const adPluck = (f: string) => (d: any) => d?.allEditions?.edges?.[0]?.node?.play?.[f]

  const adControls = await inBatches(ALLDAY_PLAY_CONTROLS, 2, (f) =>
    probeField(alldayUrl(), adQuery, {}, f, adPluck(f), true)
  )
  const adProbe = await inBatches(ALLDAY_PLAY_CANDIDATES, 4, (f) =>
    probeField(alldayUrl(), adQuery, {}, f, adPluck(f), true)
  )

  report.allday = {
    ...summarize(adControls, adProbe),
    control_detail: adControls,
    play_probe: adProbe,
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const ts = report.topshot as any
  const ad = report.allday as any
  const adDesc = adProbe.find((p) => p.field === "description")
  report.verdict = {
    topshot_conclusive: ts.conclusive,
    allday_conclusive: ad.conclusive,
    topshot_descriptive_fields_found: ts.conclusive ? ts.found.map((f: any) => f.field) : "inconclusive",
    allday_description:
      !ad.conclusive
        ? "inconclusive"
        : adDesc?.status === "yes"
          ? (typeof adDesc.sample === "string" && adDesc.sample.trim() ? "exists and populated" : "exists but empty")
          : "absent",
    allday_description_sample: ad.conclusive ? adDesc?.sample ?? null : null,
    next_step:
      "Trust ONLY arms marked conclusive. For each descriptive field found: capture it in the ingest, backfill, measure coverage, add a trigram index, THEN extend rpc_search_catalog's edition arm. Do not add the search predicate before the column is populated and indexed.",
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } })
}
