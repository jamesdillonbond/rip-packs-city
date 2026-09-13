#!/usr/bin/env node
// Compare lib/badges/official-art.ts's STATIC badge-art registry against the
// LIVE database, in BOTH directions, and against the /api/badge-image
// allowlist that has to serve every slug in it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The share cards resolve official badge art from a static map rather than
// from `badge_taxonomy` + `badge_art_overrides`, because an OG card renders
// while a social crawler holds the connection open and a taxonomy read buys
// nothing for a set that changes a few times a year. The cost of that choice
// is drift: a badge that GAINS art in the DB keeps drawing the RPC glyph on
// every share, and nothing anywhere says so — the fallback is a perfectly
// good-looking badge, so the degraded state is invisible by construction.
//
// ⚠ BOTH DIRECTIONS, deliberately. An entry the DB no longer has is as much a
// defect as one it has gained: it means the card asks /api/badge-image for a
// slug the product has retired, spending a crawler's connection to receive a
// 400 and fall back to the glyph it already had in hand.
//
// ⚠ AND IT ASSERTS THE COUNT IT INSPECTED. A registry check that silently
// inspected zero rows — an empty query result, a renamed table — exits 0 and
// reads as coverage. It fails instead if either live table comes back empty.
//
// Usage:
//   node scripts/check-badge-art-registry-drift.mjs          # report + non-zero exit on drift
//   node scripts/check-badge-art-registry-drift.mjs --json   # machine-readable
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read from
// .env.local if not already in the environment). Reads only; mutates nothing.

import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { createClient } from "@supabase/supabase-js"
import { stripCommentsWithState } from "./lib/strip-comments.mjs"

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local")
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const JSON_OUT = process.argv.includes("--json")
const REGISTRY = "lib/badges/official-art.ts"
const PROXY = "app/api/badge-image/route.ts"

// The two collections that publish badge art, by slug. Anything else has none,
// which is why the cards fall back to RPC's own glyphs there.
const PLATFORM_BY_SLUG = { nba_top_shot: "topshot", nfl_all_day: "allday" }

/** Pull `name=<slug>` out of a /api/badge-image icon_url. */
function slugOf(iconUrl) {
  const m = String(iconUrl ?? "").match(/[?&]name=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** Which `src=` an icon_url selects. Absent means the route's default: topshot. */
function srcOf(iconUrl) {
  const m = String(iconUrl ?? "").match(/[?&]src=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : "topshot"
}

// ── the static side, parsed from source ─────────────────────────────────────
// Parsed rather than imported because this is a .mjs and the registry is TS.
// Same approach as scripts/check-db-pin-staleness.mjs, which parses its pin
// list out of the guard for the same reason.
function parseObjectLiteral(src, constName) {
  const start = src.indexOf(`const ${constName}`)
  if (start === -1) throw new Error(`${REGISTRY}: could not find ${constName}`)
  const open = src.indexOf("{", start)
  const close = src.indexOf("\n}", open)
  if (open === -1 || close === -1) throw new Error(`${REGISTRY}: could not bound ${constName}`)
  const body = src.slice(open + 1, close)
  const out = {}
  for (const m of body.matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*"([^"]+)"\s*,?\s*$/gm)) {
    out[m[1]] = m[2]
  }
  if (Object.keys(out).length === 0) throw new Error(`${REGISTRY}: parsed 0 entries from ${constName}`)
  return out
}

function parseAllowlist(src, constName) {
  const start = src.indexOf(`const ${constName}`)
  if (start === -1) throw new Error(`${PROXY}: could not find ${constName}`)
  const open = src.indexOf("[", start)
  const close = src.indexOf("]", open)
  const body = src.slice(open + 1, close)
  const out = new Set()
  for (const m of body.matchAll(/'([^']+)'/g)) {
    // ⚠ SHAPE-CHECKED, not merely comment-stripped. The allowlist block carries
    // prose containing an apostrophe ("v2's chip still loads…"), which a naive
    // quoted-string scan happily reads as a slug — it did, on the first run of
    // this check, and reported two real slugs as unservable. The stripper is
    // applied below AND every capture must look like a slug, because CLAUDE.md's
    // rule is to prefer a check that does not depend on the stripper being
    // right over one that does.
    if (/^[A-Za-z0-9-]+$/.test(m[1])) out.add(m[1])
  }
  if (out.size === 0) throw new Error(`${PROXY}: parsed 0 slugs from ${constName}`)
  return out
}

/**
 * Read a source file with comments blanked.
 *
 * ⚠ ASSERTS THAT IT ACTUALLY STRIPPED. Calling the shared stripper is not the
 * same as the stripper having worked — it desynced on 10 files on 2026-09-12
 * and every one of them read as clean. A machine that ends anywhere but `code`
 * read the rest of the file in the wrong state, so this refuses to compare
 * rather than compare something it mis-parsed.
 */
function readStripped(relPath) {
  const raw = readFileSync(resolve(process.cwd(), relPath), "utf-8")
  const { code, endState, tplDepth } = stripCommentsWithState(raw)
  if (endState !== "code" || tplDepth !== 0) {
    console.error(
      `${relPath}: comment stripper desynced (endState=${endState}, tplDepth=${tplDepth}) — refusing to parse`,
    )
    process.exit(2)
  }
  return code
}

const registrySrc = readStripped(REGISTRY)
const proxySrc = readStripped(PROXY)

const staticMaps = {
  topshot: parseObjectLiteral(registrySrc, "TOPSHOT_BADGE_SLUGS"),
  allday: parseObjectLiteral(registrySrc, "ALLDAY_BADGE_SLUGS"),
}
const staticSpecials = parseObjectLiteral(registrySrc, "ALLDAY_SPECIAL_SLUGS")
const allowlists = {
  topshot: parseAllowlist(proxySrc, "TOPSHOT_SLUGS"),
  allday: parseAllowlist(proxySrc, "ALLDAY_SLUGS"),
}

// ── the live side ───────────────────────────────────────────────────────────
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
  process.exit(2)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const problems = []

const { data: taxonomy, error: taxErr } = await sb
  .from("badge_taxonomy")
  .select("normalized_key, icon_url")
if (taxErr) {
  console.error(`badge_taxonomy read failed: ${taxErr.message}`)
  process.exit(2)
}
// ⚠ The count assertion. An empty read is not "no drift".
if (!taxonomy || taxonomy.length === 0) {
  console.error("badge_taxonomy returned 0 rows — this check inspected nothing")
  process.exit(2)
}

const { data: overrides, error: ovErr } = await sb
  .from("badge_art_overrides")
  .select("normalized_key, icon_url, collections(slug)")
if (ovErr) {
  console.error(`badge_art_overrides read failed: ${ovErr.message}`)
  process.exit(2)
}
if (!overrides || overrides.length === 0) {
  console.error("badge_art_overrides returned 0 rows — this check inspected nothing")
  process.exit(2)
}

// Live expectation, built exactly the way get_badge_display_metadata resolves:
// COALESCE(override.icon_url, taxonomy.icon_url), keyed per collection.
const live = { topshot: {}, allday: {} }
for (const row of taxonomy) {
  const slug = slugOf(row.icon_url)
  if (!slug) continue
  // A taxonomy icon_url with no src= is the route's default (topshot).
  const platform = srcOf(row.icon_url) === "allday" ? "allday" : "topshot"
  live[platform][row.normalized_key] = slug
}
for (const row of overrides) {
  const platform = PLATFORM_BY_SLUG[row.collections?.slug]
  if (!platform) continue
  const slug = slugOf(row.icon_url)
  if (!slug) continue
  live[platform][row.normalized_key] = slug
}

for (const platform of ["topshot", "allday"]) {
  const want = live[platform]
  const have = staticMaps[platform]
  for (const [k, v] of Object.entries(want)) {
    if (!(k in have)) {
      problems.push(`${platform}: DB has art for "${k}" (${v}) that the registry is missing — cards draw the RPC glyph instead`)
    } else if (have[k] !== v) {
      problems.push(`${platform}: "${k}" slug drifted — registry "${have[k]}", DB "${v}"`)
    }
  }
  for (const k of Object.keys(have)) {
    if (!(k in want)) {
      problems.push(`${platform}: registry has "${k}" that the DB no longer carries art for — cards spend a fetch to get a 400`)
    }
  }
  // Every slug the registry can emit must be servable by the proxy, whose
  // allowlist is also its injection guard.
  for (const [k, v] of Object.entries(have)) {
    if (!allowlists[platform].has(v)) {
      problems.push(`${platform}: "${k}" -> "${v}" is NOT in ${PROXY}'s allowlist — that URL 400s`)
    }
  }
}

// The three special-serial slugs are not in badge_taxonomy (they are serial
// facts, not edition badges), so the DB cannot check them — but the proxy can.
for (const [cat, slug] of Object.entries(staticSpecials)) {
  if (!allowlists.allday.has(slug)) {
    problems.push(`allday special serial "${cat}" -> "${slug}" is NOT in ${PROXY}'s allowlist — that URL 400s`)
  }
}

const inspected = {
  taxonomy_rows: taxonomy.length,
  override_rows: overrides.length,
  registry_topshot: Object.keys(staticMaps.topshot).length,
  registry_allday: Object.keys(staticMaps.allday).length,
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, inspected, problems }, null, 2))
} else {
  console.log(
    `Inspected ${inspected.taxonomy_rows} badge_taxonomy rows, ${inspected.override_rows} overrides ` +
      `against ${inspected.registry_topshot} Top Shot + ${inspected.registry_allday} All Day registry entries.`,
  )
  if (problems.length === 0) {
    console.log("✓ badge art registry matches the live database and the proxy allowlist")
  } else {
    console.error(`\n✗ ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  - ${p}`)
  }
}
process.exit(problems.length === 0 ? 0 : 1)
