#!/usr/bin/env node
// scripts/qa/pack-art-audit.mjs — is every pack image the site serves actually an image?
//
// WHY (2026-09-29). pack_table_rows serves COALESCE(pack_distributions.metadata->>'thumbnail', image_url).
// Upstream art rots in ways a page check misses: a thumbnail on a sign-in host, a dead "_v0" key beside a
// working image_url, a URL with its host written twice, an .mp4 in an image slot, an empty ".../tmp/" path.
// One page showed 3 of them; this audit found 14 dead URLs on 36 rows out of 3,934.
//
// It reads every row (paged past PostgREST's 1,000 cap), requests each distinct URL once, and reports
// anything that is not "200 image/*", grouped by host and status. Read-only.
//
// USAGE
//   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/qa/pack-art-audit.mjs [out.json]
// Exit: 0 all images · 1 dead art found · 2 could not read.
import { createClient } from "@supabase/supabase-js"
import { writeFileSync } from "node:fs"

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const rows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("pack_table_rows")
    .select("dist_id, collection_slug, image_url")
    .order("dist_id")
    .order("collection_slug")
    .range(from, from + 999)
  if (error) {
    console.error("read failed:", error.message)
    process.exit(2)
  }
  rows.push(...data)
  if (data.length < 1000) break
}

const urls = [...new Set(rows.map((r) => r.image_url).filter(Boolean))]
const status = new Map()
let next = 0
async function worker() {
  while (next < urls.length) {
    const u = urls[next++]
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 20_000)
      const r = await fetch(u, { signal: ac.signal })
      clearTimeout(t)
      ac.abort() // headers are enough; do not download the art
      status.set(u, `${r.status} ${(r.headers.get("content-type") || "").split(";")[0]}`)
    } catch (e) {
      status.set(u, `ERR ${e.cause?.code || e.name}`)
    }
  }
}
await Promise.all(Array.from({ length: 10 }, worker))

const dead = [...status].filter(([, s]) => !/^200 image\//.test(s))
const byHost = {}
for (const [u, s] of dead) {
  const k = `${new URL(u).host} ${s}`
  byHost[k] = (byHost[k] || 0) + 1
}
const deadSet = new Set(dead.map(([u]) => u))
const deadRows = rows.filter((r) => deadSet.has(r.image_url)).map((r) => ({ ...r, status: status.get(r.image_url) }))

console.log(`rows ${rows.length} · distinct urls ${urls.length} · dead urls ${dead.length} on ${deadRows.length} rows`)
if (dead.length) console.log(JSON.stringify(byHost, null, 1))
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(deadRows, null, 1))
process.exit(dead.length ? 1 : 0)
