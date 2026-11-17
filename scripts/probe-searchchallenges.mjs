#!/usr/bin/env node
// scripts/probe-searchchallenges.mjs
//
// Finds the missing challenge-list field name on Top Shot's PUBLIC marketplace endpoint
// (the one the community set-challenge-tracker uses), which carries the challenge META the
// other endpoint lacks: expirationDate / maxSubmissions / numUsersCompleted / type.
//
//   POST https://v1.nbatopshot.com/marketplace/graphql   (operationName SearchChallenges)
//   searchChallenges(input: SearchChallengesInput!) -> SearchChallengesResponse { data: ChallengesSearchSummary }
//
// ChallengesSearchSummary has a `filters` facet + the challenge-list field whose name is
// unknown (introspection disabled). This walks it via "Did you mean" mining + validation
// errors, and also probes whether the challenge nodes expose slots/reward (which decides
// whether this endpoint alone can drive the ingest, or we still need getActiveChallenges).
//
// This endpoint is PUBLIC (the /challenges page renders logged-out) and reachable from
// normal egress — run it from your machine (browser UA + Origin set to pass Cloudflare):
//   node scripts/probe-searchchallenges.mjs
//
// READ-only. Paste the output back.

const ENDPOINT = process.env.SC_ENDPOINT || "https://v1.nbatopshot.com/marketplace/graphql"
const INPUT = { filters: { byActive: true } }
const THROTTLE_MS = 220
const MAX_DEPTH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let consecutiveFail = 0
class RateLimited extends Error {}

function buildQ(path, leaf) {
  let inner = leaf
  for (let i = path.length - 1; i >= 0; i--) inner = `${path[i]} { ${inner} }`
  return `query SearchChallenges($input: SearchChallengesInput!) { searchChallenges(input: $input) { ${inner} } }`
}

async function gqlRaw(query) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(ENDPOINT + "?SearchChallenges", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Origin: "https://nbatopshot.com",
        Referer: "https://nbatopshot.com/challenges",
      },
      body: JSON.stringify({ operationName: "SearchChallenges", query, variables: { input: INPUT } }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    let json = null; try { json = JSON.parse(raw) } catch { /* non-JSON */ }
    return { json, status: res.status, raw }
  } catch (e) { return { json: null, status: 0, raw: String(e?.message || e) } }
  finally { clearTimeout(t) }
}
async function gql(query) {
  await sleep(THROTTLE_MS)
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gqlRaw(query)
    if (r.json && (r.json.data !== undefined || Array.isArray(r.json.errors))) {
      consecutiveFail = 0
      return { data: r.json.data, errText: (r.json.errors?.map((e) => e.message).filter(Boolean).join(" | ") || "").trim() }
    }
    await sleep(800 * (attempt + 1))
  }
  if (++consecutiveFail >= 3) throw new RateLimited("3 consecutive non-GraphQL responses — rate-limited or Cloudflare-blocked")
  return { data: null, errText: "" }
}

const SEEDS = [
  "challenges", "data", "results", "items", "nodes", "edges", "list", "summary",
  "id", "_id", "name", "title", "description", "type", "status",
  "expirationDate", "endDate", "endTime", "startDate", "updatedAt", "createdAt",
  "maxSubmissions", "numUsersCompleted", "completions", "allocation",
  "reward", "rewards", "slots", "slot", "moments", "editions", "plays", "setID", "playID", "tiers",
]
async function mineFields(path) {
  const found = new Set()
  for (const s of SEEDS) {
    const r = await gql(buildQ(path, s + "Zqx"))
    const dym = r.errText.match(/Did you mean (.+?)\?/i)?.[1]
    if (dym) for (const m of dym.match(/"([^"]+)"/g) || []) found.add(m.replace(/"/g, ""))
  }
  return [...found]
}
async function classify(path, field) {
  const r = await gql(buildQ(path, field))
  const e = r.errText
  if (!e && r.data) return { kind: "scalar" }
  if (new RegExp(`Cannot query field ["']?${field}["']?`, "i").test(e)) return { kind: "absent" }
  if (/must have a selection of subfields/i.test(e)) return { kind: "object", type: e.match(/type "([^"]+)"/)?.[1] || "?" }
  if (/argument .* is required|argument "[^"]+" of type/i.test(e)) return { kind: "needsArg" }
  return { kind: "unknown" }
}
async function typeOf(path) { return (await gql(buildQ(path, "Zqx__probe"))).errText.match(/on type "([^"]+)"/)?.[1] || "?" }

const seen = new Set()
async function walk(path, depth) {
  const type = await typeOf(path)
  const label = "searchChallenges." + path.join(".")
  if (type !== "?" && seen.has(type)) { console.log(`${"  ".repeat(depth)}↳ ${label}: ${type} (mapped above)`); return }
  if (type !== "?") seen.add(type)
  console.log(`${"  ".repeat(depth)}• ${label}  →  type ${type}`)
  const fields = await mineFields(path)
  const objects = []
  for (const f of fields.sort()) {
    const c = await classify(path, f)
    if (c.kind === "scalar") console.log(`${"  ".repeat(depth + 1)}${f}`)
    else if (c.kind === "object") { console.log(`${"  ".repeat(depth + 1)}${f} : ${c.type} {…}`); objects.push(f) }
    else if (c.kind === "needsArg") console.log(`${"  ".repeat(depth + 1)}${f} (needs arg)`)
  }
  if (depth < MAX_DEPTH) for (const f of objects) await walk([...path, f], depth + 1)
}

async function main() {
  console.log(`# SearchChallenges probe (v1 marketplace endpoint, throttled)\n# endpoint: ${ENDPOINT}\n`)
  try {
    const ping = await gql(buildQ(["data"], "Zqx__reach"))
    console.log(`## reachability: ${ping.errText ? "GraphQL replied — " + ping.errText.slice(0, 120) : "http/other: " + JSON.stringify(ping).slice(0, 140)}\n`)
    console.log(`## Walk: searchChallenges.data (ChallengesSearchSummary) + the challenge-list node type\n`)
    await walk(["data"], 0)
    console.log(`\n# Done. The object/list field under 'data' (not 'filters') is the challenge list — its`)
    console.log(`# node fields are what we ingest. Note whether the node exposes slots/reward (if not,`)
    console.log(`# we keep pulling exact slots from getActiveChallenges and merge on id/name).`)
  } catch (e) {
    if (e instanceof RateLimited) console.log(`\n!! ${e.message}. Everything above is valid — wait ~60s and rerun.`)
    else throw e
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("probe failed:", e?.message || e); process.exit(1) })
