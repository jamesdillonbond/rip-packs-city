#!/usr/bin/env node
// scripts/probe-topshot-challenges.mjs
//
// Confirms the shape of Top Shot's challenge GraphQL BEFORE we wire the ingest cron.
// Introspection is DISABLED on public-api.nbatopshot.com, so this reconstructs the schema
// from GraphQL validation errors ("Cannot query field X on type T", "must have a selection
// of subfields", "argument N is required") — no introspection needed.
//
// Round-1 findings (already known): getActiveChallenges -> GetActiveChallengesResponse!
// (a wrapper), searchChallenges(input: SearchChallengesInput!), getChallengeByID(...).
// This round WALKS INTO getActiveChallenges + getChallengeByID to the real Challenge type
// and enumerates its fields (id/title/reward/required-moment list) by positive field probing.
//
//   TS_PROXY_URL="https://topshot-proxy.tdillonbond.workers.dev/topshot" \
//   TS_PROXY_SECRET="…" node scripts/probe-topshot-challenges.mjs
//
// READ-only. Paste the tree it prints back and we fill lib/challenges/topshot-ingest.ts.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
if (!TS_PROXY_SECRET) {
  console.error("TS_PROXY_SECRET is not set — run where the proxy secret is available.")
  process.exit(1)
}

const MAX_DEPTH = 4
let budget = 1200 // hard cap on requests

async function gql(query) {
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
    return { status: res.status, json, raw }
  } catch (e) {
    return { status: 0, json: null, raw: String(e?.message || e) }
  } finally { clearTimeout(t) }
}
const errText = (r) => (r.json?.errors?.map((e) => e.message).filter(Boolean).join(" | ") || "").trim()

// Candidate field names to probe at any object level (challenge domain + generic containers).
const DICT = [
  // containers / wrappers
  "data", "challenges", "challenge", "nodes", "node", "edges", "results", "items", "list",
  "campaigns", "activeChallenges", "challengeList", "groups", "group",
  // challenge scalars / meta
  "id", "challengeID", "name", "title", "subtitle", "description", "slug", "type",
  "challengeType", "category", "status", "state", "isActive", "isLocked", "locked",
  "startTime", "startDate", "startsAt", "endTime", "endDate", "endsAt", "expiresAt",
  "expiryDate", "deadline", "createdAt",
  // images
  "image", "imageURL", "heroImage", "thumbnail", "coverImage", "badgeImage", "assetPath",
  // reward
  "reward", "rewards", "prize", "prizes", "rewardPack", "rewardPackID", "rewardMoment",
  "rewardEdition", "rewardType", "distributionID", "distributionId", "packID",
  // completion / allocation
  "completions", "numCompleted", "completedCount", "completionCount", "totalCompleted",
  "limit", "cap", "allocation", "maxCompletions", "supply",
  // requirement / required-moment list  ← the ingest's key target
  "tiers", "tier", "steps", "step", "requirements", "requirement", "criteria",
  "momentTemplates", "requiredMomentTemplates", "requiredMoments", "moments", "moment",
  "editions", "edition", "plays", "play", "playID", "playIDs", "setID", "setPlays",
  "setPlayIDs", "slots", "slot", "flowID", "seriesID",
]

const buildQuery = (path, leaf) => {
  let inner = leaf
  for (let i = path.length - 1; i >= 0; i--) inner = `${path[i]} { ${inner} }`
  return `query { ${inner} }`
}

const seenTypes = new Set()

async function parentType(path) {
  const r = await gql(buildQuery(path, "__zzz_probe"))
  budget--
  const m = errText(r).match(/on type "([^"]+)"/)
  return m?.[1] || "?"
}

async function walk(path, depth) {
  if (budget <= 0 || depth > MAX_DEPTH) return
  const type = await parentType(path)
  if (type !== "?" && seenTypes.has(type)) {
    console.log(`${"  ".repeat(depth)}↳ ${path[path.length - 1]}: ${type} (already expanded above)`)
    return
  }
  if (type !== "?") seenTypes.add(type)
  console.log(`${"  ".repeat(depth)}• ${path.join(".") || "(root)"}  →  type ${type}`)

  const recurse = []
  for (const c of DICT) {
    if (budget <= 0) break
    const r = await gql(buildQuery(path, c))
    budget--
    const e = errText(r)
    if (new RegExp(`Cannot query field ["']?${c}["']?`, "i").test(e)) continue // field absent
    if (/must have a selection of subfields/i.test(e)) {
      const t = e.match(/type "([^"]+)"/)?.[1] || "?"
      console.log(`${"  ".repeat(depth + 1)}${c} : ${t} {…}`)
      recurse.push(c)
    } else if (/argument .* is required|argument "?\w+"? of type/i.test(e)) {
      console.log(`${"  ".repeat(depth + 1)}${c} (needs arg: ${e.slice(0, 120)})`)
    } else {
      console.log(`${"  ".repeat(depth + 1)}${c}  [scalar/leaf]`)
    }
  }
  // recurse into object fields (depth-first, budget-bounded)
  for (const c of recurse) {
    if (budget <= 0) break
    await walk([...path, c], depth + 1)
  }
}

async function main() {
  console.log(`# Top Shot challenge GraphQL probe — deep walk (introspection-free)\n# endpoint: ${TS_GQL}\n`)
  const ping = await gql(`query { __typename }`); budget--
  console.log(`## reachability: http=${ping.status} ${ping.json ? "(GraphQL JSON OK)" : "raw=" + ping.raw.slice(0, 160)}\n`)

  console.log("## Walk: getActiveChallenges")
  await walk(["getActiveChallenges"], 0)

  // getChallengeByID: reveal its arg name, then deep-walk (richest single-challenge shape).
  console.log("\n## getChallengeByID — arg discovery + walk")
  const argProbe = await gql(`query { getChallengeByID }`); budget--
  const argErr = errText(argProbe)
  const argName = argErr.match(/argument "([^"]+)"/)?.[1]
  console.log(`  arg error: ${argErr.slice(0, 200)}`)
  if (argName) {
    // static field validation happens regardless of whether the id exists
    const root = `${argName}: "1"`
    console.log(`  walking getChallengeByID(${root}) …`)
    await walk([`getChallengeByID(${root})`], 0)
  } else {
    console.log("  (could not parse arg name — paste the arg error above and I'll adapt)")
  }

  console.log(`\n# Requests used: ${1200 - budget}. Read the tree: the object field holding the`)
  console.log(`# list of required moments (editions/moments/plays → setID:playID) + the reward`)
  console.log(`# field are what the ingest needs. Paste this whole output back.`)
}

main().then(() => process.exit(0)).catch((e) => { console.error("probe failed:", e?.message || e); process.exit(1) })
