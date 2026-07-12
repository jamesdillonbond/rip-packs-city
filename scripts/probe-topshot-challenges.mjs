#!/usr/bin/env node
// scripts/probe-topshot-challenges.mjs
//
// Confirms the shape of Top Shot's challenge GraphQL BEFORE we wire the ingest cron.
// This is the one step the challenge tracker's automated ingest is blocked on — the
// challenge *definitions* (required-moment list + reward + deadline + completion count)
// live on Top Shot, not our DB, and the exact query/fields must be confirmed against the
// live schema rather than guessed.
//
// Reaches public-api.nbatopshot.com through the topshot-proxy worker (Cloudflare blocks
// Vercel/Supabase egress), exactly like lib/verify-wallet-gql.ts. Requires the proxy
// secret — run it from a session/host that has it:
//
//   TS_PROXY_URL="https://topshot-proxy.tdillonbond.workers.dev/topshot" \
//   TS_PROXY_SECRET="…" node scripts/probe-topshot-challenges.mjs
//
// It (1) introspects the root Query for any challenge-related fields and prints their
// args + return type, (2) introspects challenge-shaped object types for their fields,
// and (3) fires a few candidate queries and prints the raw responses. Read the output,
// pick the real query + field names, and fill them into lib/challenges/topshot-ingest.ts.
// The probe only READS; it writes nothing.

const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

if (!TS_PROXY_SECRET) {
  console.error("TS_PROXY_SECRET is not set — this host can't reach Top Shot's GraphQL. Run where the secret is available.")
  process.exit(1)
}

async function gql(query, variables) {
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": TS_PROXY_SECRET },
    body: JSON.stringify({ query, variables: variables ?? {} }),
    signal: AbortSignal.timeout(20_000),
  })
  const raw = await res.text()
  let json
  try { json = JSON.parse(raw) } catch { return { httpOk: res.ok, status: res.status, raw: raw.slice(0, 400) } }
  return { httpOk: res.ok, status: res.status, json }
}

function typeName(t) {
  // unwrap NON_NULL / LIST wrappers to a printable type string
  if (!t) return "?"
  if (t.kind === "NON_NULL") return `${typeName(t.ofType)}!`
  if (t.kind === "LIST") return `[${typeName(t.ofType)}]`
  return t.name || "?"
}

async function main() {
  console.log(`# Top Shot challenge GraphQL probe\n# endpoint: ${TS_GQL}\n`)

  // 1) Root Query fields mentioning "challenge"
  const rootQ = `query { __schema { queryType { fields {
    name args { name type { kind name ofType { kind name ofType { kind name } } } }
    type { kind name ofType { kind name ofType { kind name } } }
  } } } }`
  const root = await gql(rootQ)
  if (!root.json?.data) {
    console.log("Introspection failed (schema may be introspection-disabled). Raw:", JSON.stringify(root).slice(0, 500))
  } else {
    const fields = root.json.data.__schema.queryType.fields || []
    const hits = fields.filter((f) => /challenge/i.test(f.name))
    console.log(`## Root Query fields matching /challenge/i (${hits.length}):`)
    for (const f of hits) {
      const args = (f.args || []).map((a) => `${a.name}: ${typeName(a.type)}`).join(", ")
      console.log(`  ${f.name}(${args}) -> ${typeName(f.type)}`)
    }
    if (hits.length === 0) {
      console.log("  (none — challenge queries may be nested under another field; scan the full list below)")
      console.log("## All root Query field names:")
      console.log("  " + fields.map((f) => f.name).sort().join(", "))
    }
  }

  // 2) Object types whose name mentions "challenge"
  const typesQ = `query { __schema { types { kind name fields { name type { kind name ofType { kind name ofType { kind name } } } } } } }`
  const types = await gql(typesQ)
  if (types.json?.data) {
    const chTypes = (types.json.data.__schema.types || []).filter(
      (t) => t.kind === "OBJECT" && /challenge/i.test(t.name || "") && !/^__/.test(t.name || "")
    )
    console.log(`\n## Object types matching /challenge/i (${chTypes.length}):`)
    for (const t of chTypes) {
      console.log(`  type ${t.name} {`)
      for (const f of t.fields || []) console.log(`    ${f.name}: ${typeName(f.type)}`)
      console.log("  }")
    }
  }

  // 3) Candidate queries — try the historically-seen shapes; print whatever comes back.
  const candidates = [
    { label: "getActiveChallenges", q: `query { getActiveChallenges { id title endTime } }` },
    { label: "challenges", q: `query { challenges { edges { node { id title } } } }` },
    { label: "activeChallenges", q: `query { activeChallenges { id name endDate } }` },
    { label: "getChallenges", q: `query { getChallenges { data { id title } } }` },
  ]
  console.log(`\n## Candidate query probes (errors here are EXPECTED — they tell us the real field/arg names):`)
  for (const c of candidates) {
    const r = await gql(c.q)
    const err = r.json?.errors?.map((e) => e.message).join(" | ")
    console.log(`  [${c.label}] http=${r.status} ${err ? "errors: " + err.slice(0, 220) : "data: " + JSON.stringify(r.json?.data).slice(0, 220)}`)
  }

  console.log(`\n# Next: pick the confirmed query + reward/edition field names and fill them into`)
  console.log(`# lib/challenges/topshot-ingest.ts (CHALLENGE_QUERY + mapChallenge), then enable the`)
  console.log(`# cron by setting CHALLENGE_INGEST_ENABLED=true.`)
}

main().catch((e) => { console.error("probe failed:", e.message); process.exit(1) })
