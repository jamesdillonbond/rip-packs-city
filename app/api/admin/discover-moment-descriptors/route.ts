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
// V3 (2026-08-11). V2's controls did their job: the run came back INCONCLUSIVE
// on both arms rather than lying, and the captured error BODIES named the two
// causes exactly.
//   · Top Shot 422 body: `Field "SearchEditionsInput.filters" of required type
//     "EditionFilterInput!" was not provided.` — `input: { first: 1 }` is not a
//     valid SearchEditionsInput at all. V3 uses the EXACT shape the live
//     backfill-topshot-catalog route uses: a `$input: SearchEditionsInput!`
//     variable carrying `filters.bySetIDs` (UUID-format set ids only) plus
//     `searchInput.pagination`, and reads the double-`data` inline-fragment
//     response path `searchSummary.data.data[]`. The flat
//     `searchEditions { data { play } }` shape V1/V2 used does not exist.
//   · All Day 403 with an HTML `<title>block</title>` page — a WAF bot-block,
//     not a schema answer. V3 sends headers identical to the production
//     editions-hydrate path (same User-Agent) so a block, if it persists, is a
//     real finding about that ingest rather than an artifact of this probe.
//
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A real Top Shot set (Base Set) taken from our own catalog, so the probe needs
// no arguments to produce a valid query.
const DEFAULT_TS_SET_UUID = "208ae30a-a4fe-42d4-9e51-e6fd1ad2a7a9"

type Status = "yes" | "no" | "unknown"

interface ProbeResult {
  field: string
  /**
   * The GraphQL TYPE the field was probed on. Load-bearing: `found` is a flat
   * concat of the stats-arm and play-arm results, and without this label a
   * reader cannot tell which parent a hit belongs to. That exact ambiguity
   * caused a real regression on 2026-08-11 — `description` and `headline` are
   * on `Play`, but were read as `PlayStats` hits and wired into the catalog
   * backfill's `stats { }` selection, which made every query 422 and silently
   * upserted ZERO editions.
   */
  on?: string
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
  // College / school. Requested 2026-08-13: "show me players from my school" is
  // a real collector hook (Trevor: Central Michigan), and RPC cannot answer it
  // today — there is NO college column anywhere in the schema, and the only
  // college text we hold is incidental prose in a handful of Top Shot bios
  // ("Weber State" in a Lillard description). "Central Michigan" appears ZERO
  // times in any description in any collection. So the question this probe has
  // to settle is whether college is available UPSTREAM as a real field.
  "college", "school", "collegeName", "schoolName", "university",
  "lastAffiliation", "fromSchool", "playerCollege",
  // ⚠ `draftTeam` was volunteered by Top Shot itself: probing `draftPick`
  // returned `Did you mean "draftYear" or "draftTeam"?`. GraphQL's suggestion
  // list is free schema disclosure — always read the error text, not just the
  // status. Nothing has captured this field yet.
  "draftTeam",
]

const TOPSHOT_PLAY_CANDIDATES = ["description", "headline", "title", "summary", "statsValues"]

const ALLDAY_PLAY_CANDIDATES = [
  "description", "headline", "title", "playType", "gameDate",
  "homeTeamName", "awayTeamName", "homeTeamScore", "awayTeamScore",
  "week", "season", "quarter", "yards", "playerPosition", "stats",
  // ⚠ The All Day arm probed NO player bio at all, which made it structurally
  // unable to answer the college question — and All Day is where it matters
  // most: 6,190 editions / 1,520 distinct players and ZERO description prose
  // (the ingest is WAF-blocked), so there is no text to mine and a real field
  // is the ONLY route. NFL player metadata commonly carries college, so this
  // arm is the higher-value half of the probe.
  "college", "school", "collegeName", "schoolName", "university",
  "playerCollege", "height", "weight", "birthplace",
  "draftYear", "draftRound", "draftPick", "jerseyNumber",
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
    // Identical to lib/editions-hydrate.ts — a WAF that allowlists the
    // production agent must not block the probe and be misread as a schema fact.
    "User-Agent": "rip-packs-city/editions-hydrate",
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
  withSecret: boolean,
  on?: string
): Promise<ProbeResult> {
  const r = await gql(url, buildQuery(field), variables, withSecret)

  if (r.transport) {
    // A transport failure says NOTHING about the schema — unless the body
    // itself names the field as unknown, which is how Top Shot reports it.
    if (isUnknownFieldError(r.transport)) {
      return { field, on, status: "no", detail: r.transport.slice(0, 200) }
    }
    return { field, on, status: "unknown", detail: r.transport.slice(0, 200) }
  }

  const err = r.errors?.[0]?.message
  if (err && isUnknownFieldError(err)) return { field, on, status: "no", detail: err.slice(0, 200) }
  if (err) return { field, on, status: "unknown", detail: err.slice(0, 200) }

  let sample: unknown
  try { sample = pluck(r.data) } catch { sample = undefined }
  if (typeof sample === "string" && sample.length > 400) sample = sample.slice(0, 400) + "…"
  return { field, on, status: "yes", sample }
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
    found: conclusive
      ? probes.filter((p) => p.status === "yes").map((p) => ({ field: p.field, on: p.on, sample: p.sample }))
      : [],
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
  const playID = sp.get("playID") // accepted for symmetry; bySetIDs is what the schema filters on

  const report: Record<string, unknown> = {
    ran_at: new Date().toISOString(),
    probe_version: 4,
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
  // `filters` is REQUIRED and bySetIDs accepts UUID-format set ids only. The
  // default is a real, large Top Shot set so the probe is self-sufficient.
  const tsSetId = setID && UUID_RE.test(setID) ? setID : DEFAULT_TS_SET_UUID
  const tsVars = {
    input: {
      filters: { bySetIDs: [tsSetId] },
      searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
    },
  }

  // The double `data` wrapper inside `... on Editions { data { ... on Edition } }`
  // is required by the schema — not a typo.
  const tsStatsQuery = (field: string) => `
    query DescriptorProbe($input: SearchEditionsInput!) {
      searchEditions(input: $input) {
        searchSummary {
          data { ... on Editions { data { ... on Edition { play { stats { ${field} } } } } } }
        }
      }
    }`
  const tsPlayQuery = (field: string) => `
    query DescriptorProbe($input: SearchEditionsInput!) {
      searchEditions(input: $input) {
        searchSummary {
          data { ... on Editions { data { ... on Edition { play { ${field} } } } } }
        }
      }
    }`
  const tsRow = (d: any) => d?.searchEditions?.searchSummary?.data?.data?.[0]
  const tsStatsPluck = (f: string) => (d: any) => tsRow(d)?.play?.stats?.[f]
  const tsPlayPluck = (f: string) => (d: any) => tsRow(d)?.play?.[f]

  const tsControls = await inBatches(TOPSHOT_STATS_CONTROLS, 3, (f) =>
    probeField(topshotUrl(), tsStatsQuery, tsVars, f, tsStatsPluck(f), true, "PlayStats")
  )
  const tsStats = await inBatches(TOPSHOT_STATS_CANDIDATES, 4, (f) =>
    probeField(topshotUrl(), tsStatsQuery, tsVars, f, tsStatsPluck(f), true, "PlayStats")
  )
  const tsPlay = await inBatches(TOPSHOT_PLAY_CANDIDATES, 4, (f) =>
    probeField(topshotUrl(), tsPlayQuery, tsVars, f, tsPlayPluck(f), true, "Play")
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

  // ⚠ TRANSPORT LADDER. The 2026-08-13 run came back INCONCLUSIVE with
  // `HTTP 403 <title>block</title>` on the CONTROL fields — the Cloudflare WAF,
  // not a schema fact, and the probe correctly refused to report anything as
  // absent. Headers were already identical to production
  // (`X-Proxy-Secret` + the editions-hydrate User-Agent), so a single endpoint
  // could not distinguish "this URL is blocked" from "All Day is unreachable".
  //
  // This matters beyond the probe: `ALLDAY_RELAY_QUERY` has selected
  // `play { description }` since 2026-08-11 and All Day still holds ZERO
  // descriptions, which is exactly what a blocked endpoint looks like. So the
  // question "which All Day endpoint actually answers?" is the same question as
  // "why did All Day description capture never land a row?".
  //
  // topshot-proxy exposes /allday (public-api) and /allday-consumer (consumer)
  // precisely because these hostnames are WAF-blocked. Try each, cheapest first,
  // and report which one answered so the fix is a config change, not a guess.
  const adEndpoints: Array<{ label: string; url: string | null }> = [
    { label: "ALLDAY_PROXY_URL (configured)", url: process.env.ALLDAY_PROXY_URL || null },
    // ⚠ DELIBERATELY NOT PROBING `${TS_PROXY_URL}/allday` or /allday-consumer.
    // V1 of this route posted All Day to a TS_PROXY_URL subpath and 404'd, and
    // `api-admin-discover-moment-descriptors.test.ts` carries an explicit
    // regression guard — "posts All Day to ALLDAY_PROXY_URL, not a TS_PROXY_URL
    // subpath" — to stop it coming back. Adding those rungs re-derives a
    // documented dead end AND defeats the guard that records it.
    //
    // CLAUDE.md does state that topshot-proxy exposes /allday and
    // /allday-consumer as the WAF workaround, which is in tension with that
    // 404. That tension is real and unresolved, but it is an OPERATOR question
    // (curl the worker route directly and see), not something this probe should
    // settle by quietly reintroducing the shape a guard forbids.
    { label: "nflallday.com/consumer/graphql (direct)", url: "https://nflallday.com/consumer/graphql" },
  ]

  const adTransport: any[] = []
  let adWorkingUrl: string | null = null
  let adWorkingLabel: string | null = null
  for (const ep of adEndpoints) {
    if (!ep.url) {
      adTransport.push({ endpoint: ep.label, url: null, status: "skipped", detail: "not configured" })
      continue
    }
    // One CONTROL field is the whole test: it is a field production queries, so
    // a `yes` proves the transport AND the query shape in one call.
    const probe = await probeField(ep.url, adQuery, {}, ALLDAY_PLAY_CONTROLS[0], adPluck(ALLDAY_PLAY_CONTROLS[0]), true, "Play")
    adTransport.push({
      endpoint: ep.label,
      url: ep.url,
      status: probe.status,
      detail: probe.status === "yes" ? undefined : probe.detail,
      sample: probe.sample,
    })
    if (probe.status === "yes" && !adWorkingUrl) {
      adWorkingUrl = ep.url
      adWorkingLabel = ep.label
    }
  }

  // Run the real probe against whichever endpoint answered. If none did, fall
  // back to the configured one so the failure detail is still reported against
  // the endpoint the app actually uses.
  const adUrl = adWorkingUrl ?? alldayUrl()

  const adControls = await inBatches(ALLDAY_PLAY_CONTROLS, 2, (f) =>
    probeField(adUrl, adQuery, {}, f, adPluck(f), true, "Play")
  )
  const adProbe = await inBatches(ALLDAY_PLAY_CANDIDATES, 4, (f) =>
    probeField(adUrl, adQuery, {}, f, adPluck(f), true, "Play")
  )

  report.allday = {
    ...summarize(adControls, adProbe),
    transport_ladder: adTransport,
    working_endpoint: adWorkingLabel,
    probed_url_was_working_endpoint: adWorkingUrl !== null,
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
    topshot_descriptive_fields_found: ts.conclusive
      ? ts.found.map((f: any) => `${f.on ?? "?"}.${f.field}`)
      : "inconclusive",
    allday_description:
      !ad.conclusive
        ? "inconclusive"
        : adDesc?.status === "yes"
          ? (typeof adDesc.sample === "string" && adDesc.sample.trim() ? "exists and populated" : "exists but empty")
          : "absent",
    allday_description_sample: ad.conclusive ? adDesc?.sample ?? null : null,
    // Surfaced at the top level because it is the single most actionable fact
    // when the All Day arm is inconclusive: if a DIFFERENT endpoint answered,
    // the fix is one env-var change, not an investigation.
    allday_working_endpoint: ad.working_endpoint ?? null,
    allday_transport_summary: ad.working_endpoint
      ? `All Day answers on: ${ad.working_endpoint}${ad.probed_url_was_working_endpoint ? "" : " (probe fell back)"}`
      : "No All Day endpoint answered — see allday.transport_ladder for the per-endpoint failure detail.",
    // Top Shot college is SETTLED as of the 2026-08-13 run: college / school /
    // collegeName / schoolName / university / lastAffiliation / fromSchool /
    // playerCollege ALL returned hard `Cannot query field` on PlayStats with
    // every control passing. That is a real absence, not a transport artifact.
    // `birthplace` IS available ("Havre De Grace, MD, USA") and is the nearest
    // usable identity hook. GraphQL also volunteered `draftTeam` in a "Did you
    // mean" hint — a field nothing has probed yet.
    topshot_college: "absent (conclusive 2026-08-13) — use birthplace for an identity hook, or an external player→college mapping",
    next_step:
      "Trust ONLY arms marked conclusive. For each descriptive field found: capture it in the ingest, backfill, measure coverage, add a trigram index, THEN extend rpc_search_catalog's edition arm. Do not add the search predicate before the column is populated and indexed.",
  }

  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } })
}
