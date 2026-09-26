#!/usr/bin/env node
/**
 * scripts/sync-player-stats.mjs — the ESPN-fetching half of the player stats
 * feed (batch 47, 2026-09-25). Runs on a GitHub Actions runner: ESPN's public
 * JSON 403s from Supabase edge (#8) and is unmeasured from Vercel, but answers
 * 200 from a runner, the cloud sandbox and the laptop. All DB I/O goes through
 * /api/cron/player-stats-sync (Bearer INGEST_SECRET_TOKEN), so the service-role
 * key never leaves Vercel — the Atlas pattern.
 *
 * Per league:
 *   1. (nba only today) espn-resolve: identities linked to an RPC player but
 *      without an ESPN id → ESPN search by the league's display name; exactly
 *      one same-league base-name hit is accepted, anything else is recorded as
 *      unresolved:<why> so it is not retried every run.
 *   2. targets (stalest first, LIMIT per run) → athletes/<espn_id>/stats →
 *      stat lines → POST in chunks with the touched ids (a 404 — a player ESPN
 *      no longer serves — is touched too, so it leaves the front of the queue).
 *   3. final POST with the counts; the route derives ok from them.
 *
 * Env:
 *   INGEST_SECRET_TOKEN (required) · BASE_URL (default https://www.rippackscity.com)
 *   LEAGUES  (default "nfl,nba") · LIMIT (default 300 targets/league/run)
 *   RESOLVE_LIMIT (default 150 searches/run) · DRY_RUN=1 (fetch, write nothing)
 *   DEADLINE_MS (default 20 min — under the workflow's timeout-minutes, so a
 *   slow ESPN ends in a logged, partial run instead of a SIGKILL with no row)
 */

import { ESPN_LEAGUES, chunk, espnSearchUrl, espnStatsUrl, matchEspnSearch, parseEspnStats, pickProbedCandidate, slugToQuery } from "./lib/espn-player-stats.mjs"

const BASE_URL = (process.env.BASE_URL || "https://www.rippackscity.com").replace(/\/$/, "")
const TOKEN = process.env.INGEST_SECRET_TOKEN
const LEAGUES = (process.env.LEAGUES || "nfl,nba").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 300
// 150 → 400 (batch 58): a dispatched run resolved 150 and fetched 300 players in
// 2.6 min (2026-09-25 6:31 PM PT), so 400 searches at 250 ms sit well inside
// the 20-min deadline and the 931 still-unkeyed Top Shot names clear in ~3 ticks.
const RESOLVE_LIMIT = process.env.RESOLVE_LIMIT ? Number(process.env.RESOLVE_LIMIT) : 400
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true"
const DEADLINE_MS = process.env.DEADLINE_MS ? Number(process.env.DEADLINE_MS) : 20 * 60 * 1000
const ESPN_DELAY_MS = 250
const CHUNK_PLAYERS = 40
const ROUTE = `${BASE_URL}/api/cron/player-stats-sync`
const UA = "rippackscity-player-stats-sync/1 (+https://www.rippackscity.com)"

if (!TOKEN) {
  console.error("INGEST_SECRET_TOKEN is required")
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const pastDeadline = () => Date.now() - t0 > DEADLINE_MS

async function routeGet(qs) {
  const res = await fetch(`${ROUTE}?${qs}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(30_000) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`route GET ${qs}: HTTP ${res.status} ${body.error ?? ""}`)
  return body
}

async function routePost(payload) {
  const res = await fetch(ROUTE, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(55_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`route POST: HTTP ${res.status} ${body.error ?? ""}`)
  return body
}

/** ESPN GET → { status, json|null }. Never throws on HTTP; throws on network. */
async function espnGet(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) return { status: 404, json: null }
  if (!res.ok) return { status: res.status, json: null }
  return { status: 200, json: await res.json() }
}

// The run's identity for the route's heartbeat: the SAME startedAt the final
// POST logs, and hb=1 on the run's FIRST route call only (nba: the resolve
// phase; nfl: targets). See the route header — a heartbeat written later than
// the terminal row's started_at reads as a wall kill.
function runQs(stats) {
  const first = !stats.hb_sent
  stats.hb_sent = true
  return `startedAt=${encodeURIComponent(stats.started_at)}&hb=${first ? 1 : 0}`
}

async function resolveEspnIds(league, stats) {
  const { targets } = await routeGet(`phase=espn-resolve-targets&league=${league}&limit=${RESOLVE_LIMIT}&${runQs(stats)}`)
  stats.resolve_targets = targets.length
  const out = []
  for (const t of targets) {
    if (pastDeadline()) { stats.deadline_hit = true; break }
    // The catalog spelling first, then every other spelling RPC knows for the
    // person ("Steph Curry" is Stephen Curry to ESPN; the alias row says so).
    // A search that FAILS (HTTP / network) leaves the target untouched for the
    // next run; only a search that ANSWERED without a match is recorded.
    const spellings = [t.display_name, ...(Array.isArray(t.aliases) ? t.aliases.map(slugToQuery) : [])].filter(Boolean)
    let verdict = null
    let failed = false
    for (const [i, name] of spellings.entries()) {
      if (pastDeadline()) { stats.deadline_hit = true; break }
      try {
        const r = await espnGet(espnSearchUrl(league, name, 10))
        if (r.status !== 200) {
          failed = true
          stats.errors.push(`search ${name}: HTTP ${r.status}`)
          break
        }
        let m = matchEspnSearch(r.json, league, name)
        // Duplicate ESPN entries (a G League copy, a phantom) and a player
        // now filed abroad (fiba / nbl) are settled by their STATS: the one
        // candidate with seasons under this league's stats path is the person.
        if (!m.espn_id && m.candidates && m.candidates.length > 0 && m.candidates.length <= 4) {
          const probed = []
          for (const c of m.candidates) {
            for (const el of ESPN_LEAGUES[league]) {
              const pr = await espnGet(espnStatsUrl(league, c.id, el))
              let seasons = 0
              if (pr.status === 200) {
                try { seasons = new Set(parseEspnStats(pr.json, c.id).map((row) => row.season)).size } catch { seasons = 0 }
              }
              probed.push({ id: c.id, espn_league: el, seasons })
              await sleep(ESPN_DELAY_MS)
            }
          }
          const picked = pickProbedCandidate(probed)
          if (picked.espn_id) m = { ...picked, candidates: [] }
          else if (picked.matched_by.startsWith("unresolved:ambiguous")) m = { ...m, matched_by: picked.matched_by }
        }
        if (m.espn_id) {
          verdict = { ...m, matched_by: i === 0 ? m.matched_by : `${m.matched_by}:alias:${t.aliases[i - 1]}` }
          break
        }
        if (verdict === null || m.matched_by.startsWith("unresolved:ambiguous")) verdict = m
      } catch (err) {
        failed = true
        stats.errors.push(`search ${name}: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
      await sleep(ESPN_DELAY_MS)
    }
    if (failed) {
      stats.resolve_failed++
    } else if (verdict) {
      out.push({ identity_id: t.identity_id, espn_id: verdict.espn_id, espn_league: verdict.espn_league, matched_by: verdict.matched_by })
      if (verdict.espn_id) stats.resolved++
      else stats.unresolved++
    }
    await sleep(ESPN_DELAY_MS)
  }
  if (out.length && !DRY_RUN) {
    const r = await routePost({ league, espn_ids: out })
    console.log(`[${league}] espn ids written: ${r.updated} (resolved ${stats.resolved}, unresolved ${stats.unresolved})`)
  } else {
    console.log(`[${league}] espn ids: resolved ${stats.resolved}, unresolved ${stats.unresolved}${DRY_RUN ? " (dry run)" : ""}`)
  }
}

async function syncStats(league, stats) {
  const { targets } = await routeGet(`phase=targets&league=${league}&limit=${LIMIT}&${runQs(stats)}`)
  stats.targets = targets.length
  // Players whose fetch FAILED (not 404): stamped stats_failed_at at the end so
  // one ESPN keeps 500ing on stops heading every run (20260926025347).
  const failedIds = []
  const parts = chunk(targets, CHUNK_PLAYERS)
  for (const part of parts) {
    if (pastDeadline()) { stats.deadline_hit = true; break }
    const rows = []
    const touched = []
    for (const t of part) {
      if (pastDeadline()) { stats.deadline_hit = true; break }
      try {
        const r = await espnGet(espnStatsUrl(league, t.espn_id, t.espn_league || league))
        if (r.status === 404) {
          stats.fetched_404++
          touched.push(t.espn_id)
        } else if (r.status !== 200) {
          stats.fetched_failed++
          failedIds.push(t.espn_id)
          stats.errors.push(`stats ${t.espn_id}: HTTP ${r.status}`)
        } else {
          rows.push(...parseEspnStats(r.json, t.espn_id))
          touched.push(t.espn_id)
          stats.fetched_ok++
        }
      } catch (err) {
        stats.fetched_failed++
        failedIds.push(t.espn_id)
        stats.errors.push(`stats ${t.espn_id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await sleep(ESPN_DELAY_MS)
    }
    if (touched.length === 0) continue
    stats.chunks++
    if (DRY_RUN) {
      stats.chunks_ok++
      console.log(`[${league}] dry run: ${rows.length} rows for ${touched.length} players`)
      continue
    }
    try {
      const r = await routePost({ league, rows, touched })
      stats.chunks_ok++
      stats.rows_upserted += typeof r.upserted === "number" ? r.upserted : 0
    } catch (err) {
      stats.errors.push(`chunk: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failedIds.length && !DRY_RUN) {
    try {
      const r = await routePost({ league, failed_espn_ids: failedIds })
      console.log(`[${league}] failed fetches stamped: ${r.marked} of ${failedIds.length}`)
    } catch (err) {
      // not fatal to the run: those players simply stay at the queue head
      stats.errors.push(`mark failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function runLeague(league) {
  const startedAt = new Date().toISOString()
  const stats = {
    targets: 0, fetched_ok: 0, fetched_404: 0, fetched_failed: 0,
    rows_upserted: 0, chunks: 0, chunks_ok: 0,
    resolve_targets: 0, resolved: 0, unresolved: 0, resolve_failed: 0,
    deadline_hit: false, errors: [],
    runner_event: process.env.GITHUB_EVENT_NAME || "local",
    started_at: startedAt, hb_sent: false,
  }
  try {
    if (league === "nba") await resolveEspnIds(league, stats)
    await syncStats(league, stats)
  } catch (err) {
    // a route or targets failure: still log a terminal row saying so
    stats.errors.push(`run: ${err instanceof Error ? err.message : String(err)}`)
    stats.fetched_failed++
  }
  console.log(`[${league}] targets ${stats.targets} · ok ${stats.fetched_ok} · 404 ${stats.fetched_404} · failed ${stats.fetched_failed} · rows ${stats.rows_upserted} · chunks ${stats.chunks_ok}/${stats.chunks}${stats.deadline_hit ? " · DEADLINE" : ""}`)
  if (stats.errors.length) console.log(`[${league}] first errors: ${stats.errors.slice(0, 5).join(" | ")}`)
  if (DRY_RUN) return true
  const fin = await routePost({ final: true, league, startedAt, stats: { ...stats, started_at: undefined, hb_sent: undefined, errors: stats.errors.slice(0, 10) } })
  console.log(`[${league}] logged: ok=${fin.ok} ${fin.problems?.length ? fin.problems.join("; ") : ""}`)
  return fin.ok === true
}

let allOk = true
for (const league of LEAGUES) {
  if (league !== "nfl" && league !== "nba") {
    console.error(`unknown league ${league}`)
    allOk = false
    continue
  }
  const ok = await runLeague(league)
  allOk = allOk && ok
}
process.exit(allOk ? 0 : 1)
