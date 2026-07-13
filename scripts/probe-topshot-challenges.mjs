#!/usr/bin/env node
// scripts/probe-topshot-challenges.mjs
//
// Confirms the shape of Top Shot's challenge GraphQL BEFORE we wire the ingest cron.
// Introspection is DISABLED, so this reconstructs the schema from validation errors.
//
// Confirmed: getActiveChallenges -> { challenges: [UserChallenge!] }, where
//   UserChallenge { id name description type reward:ChallengeReward requirements:[Requirement!] slots:[ChallengeSlot!] }
//   ChallengeReward { playID setID … }
// This round ENUMERATES each type's real field names by mining GraphQL's "Did you mean"
// suggestions (catches fields a fixed guess-list misses — deadline/status/required-moment
// fields), then classifies + walks every object field (incl. slots + requirements).
// Throttled + rate-limit-safe (aborts cleanly; rerun after ~60s if it trips).
//
//   TS_PROXY_URL="https://topshot-proxy.tdillonbond.workers.dev/topshot" \
//   TS_PROXY_SECRET="…" node scripts/probe-topshot-challenges.mjs
//
// READ-only. Paste the tree it prints back and we fill lib/challenges/topshot-ingest.ts.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
if (!TS_PROXY_SECRET) { console.error("TS_PROXY_SECRET is not set — run where the secret is available."); process.exit(1) }

const THROTTLE_MS = 220
const MAX_DEPTH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let consecutiveFail = 0
class RateLimited extends Error {}

async function gqlRaw(query) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": TS_PROXY_SECRET },
      body: JSON.stringify({ query }), signal: ctrl.signal,
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
  if (++consecutiveFail >= 3) throw new RateLimited("3 consecutive non-GraphQL responses — API is rate-limiting")
  return { data: null, errText: "" }
}
const buildQuery = (path, leaf) => { let s = leaf; for (let i = path.length - 1; i >= 0; i--) s = `${path[i]} { ${s} }`; return `query { ${s} }` }

// Enumerate a type's real field names by mining "Did you mean" from bogus-field errors.
const SEEDS = [
  "name", "title", "description", "id", "type", "status", "state",
  "endTime", "endDate", "startTime", "expiresAt", "deadline", "closesAt",
  "reward", "requirements", "slots", "moment", "edition", "playID", "setID",
  "tier", "count", "progress", "completed", "completions", "image", "series",
]
async function mineFields(path) {
  const found = new Set()
  for (const s of SEEDS) {
    const r = await gql(buildQuery(path, s + "Zqx"))
    const dym = r.errText.match(/Did you mean (.+?)\?/i)?.[1]
    if (dym) for (const m of dym.match(/"([^"]+)"/g) || []) found.add(m.replace(/"/g, ""))
  }
  return [...found]
}
async function classify(path, field) {
  const r = await gql(buildQuery(path, field))
  const e = r.errText
  if (!e && r.data) return { kind: "scalar" }
  if (new RegExp(`Cannot query field ["']?${field}["']?`, "i").test(e)) return { kind: "absent" }
  if (/must have a selection of subfields/i.test(e)) return { kind: "object", type: e.match(/type "([^"]+)"/)?.[1] || "?" }
  if (/argument .* is required|argument "[^"]+" of type/i.test(e)) return { kind: "needsArg", detail: e.slice(0, 120) }
  return { kind: "unknown" }
}
async function typeOf(path) { return (await gql(buildQuery(path, "Zqx__probe"))).errText.match(/on type "([^"]+)"/)?.[1] || "?" }

const seenTypes = new Set()
async function walk(path, depth) {
  const type = await typeOf(path)
  const label = path.join(".")
  if (type !== "?" && seenTypes.has(type)) { console.log(`${"  ".repeat(depth)}↳ ${label}: ${type} (mapped above)`); return }
  if (type !== "?") seenTypes.add(type)
  console.log(`${"  ".repeat(depth)}• ${label}  →  type ${type}`)

  const fields = await mineFields(path)
  const objects = []
  for (const f of fields.sort()) {
    const c = await classify(path, f)
    if (c.kind === "scalar") console.log(`${"  ".repeat(depth + 1)}${f}`)
    else if (c.kind === "object") { console.log(`${"  ".repeat(depth + 1)}${f} : ${c.type} {…}`); objects.push(f) }
    else if (c.kind === "needsArg") console.log(`${"  ".repeat(depth + 1)}${f} (needs arg)`)
    // absent/unknown: skip (mined names are usually real; unknowns are rate-limit noise)
  }
  if (depth < MAX_DEPTH) for (const f of objects) await walk([...path, f], depth + 1)
}

async function main() {
  console.log(`# Top Shot challenge GraphQL — full field enumeration (Did-you-mean mining, throttled)\n# endpoint: ${TS_GQL}\n`)
  try {
    const ping = await gql(`query { __typename }`)
    console.log(`## reachability: ${ping.data ? "GraphQL OK" : "errors: " + ping.errText.slice(0, 120)}\n`)
    console.log(`## Walk: getActiveChallenges.challenges (UserChallenge) + all nested objects\n`)
    await walk(["getActiveChallenges", "challenges"], 0)
    console.log(`\n# Done. Paste this whole tree back. What matters: the field(s) holding the`)
    console.log(`# required moments (setID/playID per slot/requirement), the reward (setID/playID),`)
    console.log(`# the deadline field, and any status/completion-count field.`)
  } catch (e) {
    if (e instanceof RateLimited) console.log(`\n!! ${e.message}. Everything above is valid — wait ~60s and rerun.`)
    else throw e
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("probe failed:", e?.message || e); process.exit(1) })
