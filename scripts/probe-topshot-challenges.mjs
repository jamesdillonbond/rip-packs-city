#!/usr/bin/env node
// scripts/probe-topshot-challenges.mjs
//
// Confirms the shape of Top Shot's challenge GraphQL BEFORE we wire the ingest cron.
// Introspection is DISABLED, so this reconstructs the schema from validation errors.
//
// Confirmed so far: getActiveChallenges -> GetActiveChallengesResponse { challenges:
// [UserChallenge!] }. This round enumerates the UserChallenge type (and its reward /
// required-moment sub-objects), plus getChallengeByID's arg + shape. Throttled + retried
// so it doesn't trip the API's rate limit, and it ABORTS (rather than mislabeling
// rate-limited responses as "scalar") if the limit is hit — just wait ~60s and rerun.
//
//   TS_PROXY_URL="https://topshot-proxy.tdillonbond.workers.dev/topshot" \
//   TS_PROXY_SECRET="…" node scripts/probe-topshot-challenges.mjs
//
// READ-only. Paste the tree it prints back and we fill lib/challenges/topshot-ingest.ts.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
if (!TS_PROXY_SECRET) { console.error("TS_PROXY_SECRET is not set — run where the secret is available."); process.exit(1) }

const THROTTLE_MS = 200
const MAX_DEPTH = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let consecutiveFail = 0
class RateLimited extends Error {}

// One GraphQL request, throttled, with retry/backoff on non-validation responses.
// Returns { data, errText } for a clean GraphQL reply; throws RateLimited after 3 bad tries.
async function gqlRaw(query) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": TS_PROXY_SECRET },
      body: JSON.stringify({ query }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    let json = null
    try { json = JSON.parse(raw) } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, raw }
  } catch (e) {
    return { ok: false, status: 0, json: null, raw: String(e?.message || e) }
  } finally { clearTimeout(t) }
}

async function gql(query) {
  await sleep(THROTTLE_MS)
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gqlRaw(query)
    // A clean GraphQL reply has JSON with either data or errors[].
    if (r.json && (r.json.data !== undefined || Array.isArray(r.json.errors))) {
      consecutiveFail = 0
      const errText = (r.json.errors?.map((e) => e.message).filter(Boolean).join(" | ") || "").trim()
      return { data: r.json.data, errText }
    }
    // Non-GraphQL response (429/5xx/HTML/empty) → back off and retry.
    await sleep(800 * (attempt + 1))
  }
  if (++consecutiveFail >= 3) throw new RateLimited("3 consecutive non-GraphQL responses — API is rate-limiting")
  return { data: null, errText: "" } // soft-unknown (won't be classified as scalar)
}

const buildQuery = (path, leaf) => {
  let inner = leaf
  for (let i = path.length - 1; i >= 0; i--) inner = `${path[i]} { ${inner} }`
  return `query { ${inner} }`
}

const DICT = [
  "id", "challengeID", "name", "title", "subtitle", "description", "slug", "type",
  "challengeType", "category", "kind", "status", "state", "isActive", "isLocked", "locked",
  "progress", "userProgress", "completed", "isComplete", "ownedCount", "requiredCount",
  "startTime", "startDate", "startsAt", "endTime", "endDate", "endsAt", "expiresAt",
  "expiryDate", "deadline", "createdAt", "updatedAt",
  "image", "imageURL", "heroImage", "thumbnail", "coverImage", "badgeImage", "assetPath",
  "reward", "rewards", "prize", "prizes", "rewardPack", "rewardPackID", "rewardMoment",
  "rewardEdition", "rewardType", "rewardName", "distributionID", "distributionId", "packID",
  "completions", "numCompleted", "completedCount", "completionCount", "totalCompleted",
  "limit", "cap", "allocation", "maxCompletions", "supply",
  "tiers", "tier", "steps", "step", "requirements", "requirement", "criteria", "rules",
  "momentTemplates", "requiredMomentTemplates", "requiredMoments", "requiredEditions",
  "moments", "moment", "editions", "edition", "plays", "play", "playID", "playIDs",
  "setID", "setPlayID", "setPlays", "setPlayIDs", "slots", "slot", "flowID", "seriesID",
  "playDataID", "editionFlowID",
]

const seenTypes = new Set()

// Classify one field at a path. Returns 'absent' | {scalar} | {object:T} | {needsArg} | 'unknown'.
async function classifyField(path, field) {
  const r = await gql(buildQuery(path, field))
  const e = r.errText
  if (!e && r.data && r.data !== null) return { kind: "scalar" }
  if (new RegExp(`Cannot query field ["']?${field}["']?`, "i").test(e)) return { kind: "absent" }
  if (/must have a selection of subfields/i.test(e)) {
    return { kind: "object", type: e.match(/type "([^"]+)"/)?.[1] || "?" }
  }
  if (/argument .* is required|argument "[^"]+" of type/i.test(e)) return { kind: "needsArg", detail: e.slice(0, 140) }
  return { kind: "unknown", detail: e.slice(0, 140) }
}

async function typeOf(path) {
  const r = await gql(buildQuery(path, "__zzz_probe"))
  return r.errText.match(/on type "([^"]+)"/)?.[1] || "?"
}

async function walk(path, depth) {
  const type = await typeOf(path)
  const label = path.join(".")
  if (type !== "?" && seenTypes.has(type)) { console.log(`${"  ".repeat(depth)}↳ ${label}: ${type} (mapped above)`); return }
  if (type !== "?") seenTypes.add(type)
  console.log(`${"  ".repeat(depth)}• ${label}  →  type ${type}`)

  const objectFields = []
  for (const f of DICT) {
    const c = await classifyField(path, f)
    if (c.kind === "absent" || c.kind === "unknown") continue
    if (c.kind === "scalar") console.log(`${"  ".repeat(depth + 1)}${f}`)
    else if (c.kind === "needsArg") console.log(`${"  ".repeat(depth + 1)}${f} (needs arg: ${c.detail})`)
    else if (c.kind === "object") { console.log(`${"  ".repeat(depth + 1)}${f} : ${c.type} {…}`); objectFields.push(f) }
  }
  if (depth < MAX_DEPTH) {
    // Only recurse into fields likely to hold the reward or required-moment list (saves requests).
    const worth = /reward|prize|pack|moment|edition|play|step|require|criteria|rule|tier|progress/i
    for (const f of objectFields) {
      if (worth.test(f)) await walk([...path, f], depth + 1)
    }
  }
}

async function main() {
  console.log(`# Top Shot challenge GraphQL probe — UserChallenge deep walk (throttled)\n# endpoint: ${TS_GQL}\n`)
  try {
    const ping = await gql(`query { __typename }`)
    console.log(`## reachability: ${ping.data ? "GraphQL OK" : "errors: " + ping.errText.slice(0, 120)}\n`)

    console.log(`## getChallengeByID — arg discovery`)
    const a = await gql(`query { getChallengeByID }`)
    console.log(`  ${a.errText.slice(0, 220) || "(no error text)"}`)
    const argName = a.errText.match(/argument "([^"]+)"/)?.[1]

    console.log(`\n## Walk: getActiveChallenges.challenges (UserChallenge)`)
    await walk(["getActiveChallenges", "challenges"], 0)

    if (argName) {
      console.log(`\n## Walk: getChallengeByID(${argName}: "1")  [static field validation — id need not exist]`)
      await walk([`getChallengeByID(${argName}: "1")`], 0)
    }

    console.log(`\n# Done. The field on UserChallenge holding the required-moment list`)
    console.log(`# (moments/editions/plays/steps → setID:playID) + the reward field are what the`)
    console.log(`# ingest needs. Paste this whole output back.`)
  } catch (e) {
    if (e instanceof RateLimited) {
      console.log(`\n!! ${e.message}. Wait ~60s and rerun — the throttle usually avoids this, and`)
      console.log(`!! everything printed above this line is valid.`)
    } else throw e
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("probe failed:", e?.message || e); process.exit(1) })
