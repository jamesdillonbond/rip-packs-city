#!/usr/bin/env node
// scripts/probe-topshot-challenges.mjs
//
// Confirms the shape of Top Shot's challenge GraphQL BEFORE we wire the ingest cron.
// This is the one step the challenge tracker's automated ingest is blocked on — the
// challenge *definitions* (required-moment list + reward + deadline + completion count)
// live on Top Shot, not our DB, and the exact query/fields must be confirmed against the
// live schema rather than guessed.
//
// Top Shot has schema INTROSPECTION DISABLED, so this probes the schema indirectly via
// GraphQL's validation errors: sending a deliberately-wrong query makes the server reply
// with "Did you mean X?" (reveals real field names), "must have a selection of subfields"
// (reveals a field EXISTS + its return type), or "argument N is required" (reveals args).
// That's enough to reconstruct the query without introspection.
//
// Reaches public-api.nbatopshot.com through the topshot-proxy worker (Cloudflare blocks
// Vercel/Supabase egress), like lib/verify-wallet-gql.ts. Requires the proxy secret:
//
//   TS_PROXY_URL="https://topshot-proxy.tdillonbond.workers.dev/topshot" \
//   TS_PROXY_SECRET="…" node scripts/probe-topshot-challenges.mjs
//
// It only READS. Paste the findings back and we fill lib/challenges/topshot-ingest.ts.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

if (!TS_PROXY_SECRET) {
  console.error("TS_PROXY_SECRET is not set — this host can't reach Top Shot's GraphQL. Run where the secret is available.")
  process.exit(1)
}

// fetch with a manual timeout (AbortSignal.timeout trips a libuv teardown assertion on
// Windows Node); clear the timer so the event loop drains cleanly.
async function gql(query, variables) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": TS_PROXY_SECRET },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    let json = null
    try { json = JSON.parse(raw) } catch { /* non-JSON */ }
    return { status: res.status, json, raw }
  } catch (e) {
    return { status: 0, json: null, raw: String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

const errText = (r) =>
  (r.json?.errors?.map((e) => e.message).filter(Boolean).join(" | ") || "").trim()

// Classify a bare `query { NAME }` probe from the validation error it produces.
function classify(name, r) {
  const err = errText(r)
  if (!err && r.json?.data && r.json.data[name] !== undefined) return { state: "EXISTS_SCALAR", detail: "returned data with no subselection" }
  if (/must have a selection of subfields/i.test(err)) {
    const t = err.match(/type "([^"]+)"/)?.[1] || err.match(/type '([^']+)'/)?.[1]
    return { state: "EXISTS", detail: `returns object type ${t || "?"}` }
  }
  if (/argument "?[\w]+"? of type|argument .* is required|is required, but it was not provided/i.test(err)) {
    return { state: "EXISTS_NEEDS_ARG", detail: err.slice(0, 200) }
  }
  if (/Cannot query field/i.test(err)) {
    const dym = err.match(/Did you mean ([^?]+)\?/i)?.[1]
    return { state: "MISSING", detail: dym ? `did you mean: ${dym}` : "no suggestion" }
  }
  return { state: "?", detail: err.slice(0, 200) || `http ${r.status}` }
}

async function main() {
  console.log(`# Top Shot challenge GraphQL probe (introspection-independent)\n# endpoint: ${TS_GQL}\n`)

  // Sanity: is the endpoint answering GraphQL at all?
  const ping = await gql(`query { __typename }`)
  console.log(`## reachability: http=${ping.status} ${ping.json ? "(GraphQL JSON OK)" : "raw=" + ping.raw.slice(0, 160)}\n`)

  // 1) Root-field discovery via validation errors + "Did you mean".
  const rootCandidates = [
    "challenge", "challenges", "getChallenge", "getChallenges", "getActiveChallenges",
    "activeChallenges", "searchChallenges", "allChallenges", "challengeGroups",
    "getChallengeGroups", "challengeGroup", "setChallenges", "getSetChallenges",
  ]
  console.log("## Root-field probes (state — detail):")
  const exists = []
  for (const name of rootCandidates) {
    const r = await gql(`query { ${name} }`)
    const c = classify(name, r)
    if (c.state.startsWith("EXISTS")) exists.push({ name, ...c })
    console.log(`  ${name.padEnd(22)} ${c.state.padEnd(16)} ${c.detail}`)
  }

  // 2) For fields that EXIST, discover their subfields the same way (bare invalid subfield
  //    → "Did you mean"), so we learn id / title / reward / required-moment field names.
  const subCandidates = [
    "id", "title", "name", "description", "endTime", "endDate", "endsAt", "expiryDate",
    "status", "state", "isActive", "completedCount", "numCompleted", "limit", "allocation",
    "reward", "rewards", "rewardPack", "rewardPackId", "distributionId", "moments",
    "requiredMoments", "editions", "plays", "setPlays", "steps", "requirements", "image", "thumbnail",
  ]
  for (const f of exists) {
    console.log(`\n## Subfield probes for root "${f.name}" (${f.detail}):`)
    // If it needs an arg, we can still probe subfields by asking for a bogus subfield;
    // the arg error may mask this, so try both with and without a placeholder arg.
    for (const attempt of [`query { ${f.name} { __zzz } }`, `query { ${f.name}(id:"1") { __zzz } }`]) {
      const r = await gql(attempt)
      const err = errText(r)
      if (/Cannot query field "__zzz"/i.test(err)) {
        // Server accepted the shape; __zzz is the only bad field → its suggestions list real fields.
        console.log(`  [shape ok] ${err.slice(0, 240)}`)
        // Positively confirm each guessed subfield: it exists unless the error says
        // "Cannot query field <sf>". "must have a selection of subfields" means it's a nested object.
        const good = []
        for (const sf of subCandidates) {
          const rr = await gql(attempt.replace("__zzz", sf))
          const e2 = errText(rr)
          const missing = new RegExp(`Cannot query field ["']?${sf}["']?`, "i").test(e2)
          if (!missing) good.push(sf + (/must have a selection of subfields/i.test(e2) ? "{…}" : ""))
        }
        console.log(`  confirmed subfields: ${good.join(", ") || "(none of the guesses matched — read the suggestion list above)"}`)
        break
      } else if (err) {
        console.log(`  [${attempt}] ${err.slice(0, 200)}`)
      }
    }
  }

  console.log(`\n# Read the EXISTS root field + its confirmed subfields above. The required-moment`)
  console.log(`# list (editions/moments/plays → setID:playID) and the reward field are what the`)
  console.log(`# ingest needs. Paste this output back and we fill lib/challenges/topshot-ingest.ts.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("probe failed:", e?.message || e); process.exit(1) })
