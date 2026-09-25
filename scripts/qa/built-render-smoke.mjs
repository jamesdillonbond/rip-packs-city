#!/usr/bin/env node
// Built-app render smoke — boots the PRODUCTION build (`next start`) and requests
// one URL per page route, collection routes once per registered collection.
//
// WHY THIS EXISTS. On 2026-09-20 `await connection()` inside an ISR segment raised
// `DYNAMIC_SERVER_USAGE` and every /disney-pinnacle/edition/<id> answered 500 while
// `tsc`, lint, the ratchet and ~18k vitest cases were green: that error class
// exists only in a real render of the built app, and nothing in CI rendered one.
// Same for a module that throws at evaluation (a missing env guard), a route that
// crashes before its first byte, or a segment config Next rejects at runtime.
//
// WHAT IT RUNS AGAINST. CI builds with placeholder env and a Supabase URL that
// refuses connections (127.0.0.1:9), so every data read FAILS FAST. That is on
// purpose — it makes this the platform's failed-read path, rendered for real:
//   • a page must answer < 500 (an honest degraded state or a 404 is fine);
//   • a 5xx is a page that turns an unreachable DB into a crash;
//   • `DYNAMIC_SERVER_USAGE` anywhere (body or server log) fails regardless.
// A route handler under /api/** is out of scope — many are gated or POST-only,
// and `lib/api-error.ts` already owns their 5xx contract (a 503 there is honest).
//
// ⚠ It is NOT a data check and cannot see a wrong number; it sees a render that
// cannot happen. Known 5xx routes live in KNOWN_5XX with a reason — the ratchet
// fails when one starts answering < 500 too, so the list can only shrink.
//
// Usage:
//   node scripts/qa/built-render-smoke.mjs            # spawns `next start` on :3137
//   BASE_URL=http://localhost:3000 node scripts/qa/built-render-smoke.mjs
//   node scripts/qa/built-render-smoke.mjs --list     # print the URL set, no requests

import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const MANIFEST = path.join(ROOT, ".next", "app-path-routes-manifest.json")
const PORT = Number(process.env.PORT || 3137)
const EXTERNAL = process.env.BASE_URL
const BASE = (EXTERNAL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "")
const TIMEOUT_MS = Number(process.env.RENDER_SMOKE_TIMEOUT_MS || 45_000)
const CONCURRENCY = Number(process.env.RENDER_SMOKE_CONCURRENCY || 4)

// Routes that answer 5xx against an unreachable DB TODAY, each with why. Keyed on
// the ROUTE PATTERN (manifest value), not the URL. Empty is the goal.
export const KNOWN_5XX = new Map([
  // ["/example/[id]", "reason + date"],
])

// Placeholder for a non-collection dynamic segment. Shaped to be valid-looking
// for the common id kinds so a route reaches its data read rather than an early
// param-validation 404 (which would test nothing).
const PARAM_VALUES = {
  momentId: "1",
  id: "1",
  distId: "1",
  set_id: "1",
  address: "0x0b2a3299cc857e29",
  wallet: "0x0b2a3299cc857e29",
  username: "ci-render-probe",
  slug: "ci-render-probe",
  topic: "fmv",
  league: "nba",
}

/** Collection ids from the registry itself — never a hand-kept list (a list
 * beside a registry goes stale silently). */
export function registryCollectionIds(src) {
  const start = src.indexOf("export const COLLECTIONS")
  if (start < 0) throw new Error("COLLECTIONS not found in lib/collections.ts")
  const body = src.slice(start)
  return [...body.matchAll(/^ {4}id: "([a-z0-9-]+)"/gm)].map((m) => m[1])
}

/** Expand manifest route patterns into concrete paths. Pure. */
export function expandRoutes(patterns, collectionIds) {
  const out = []
  for (const pattern of [...new Set(patterns)].sort()) {
    if (pattern.startsWith("/api/") || pattern === "/api") continue
    if (pattern.split("/").some((seg) => seg.startsWith("_"))) continue // /_not-found, /_global-error
    const colls = pattern.includes("[collection]") ? collectionIds : [null]
    for (const c of colls) {
      let unresolved = false
      const p = pattern.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, _dots, name) => {
        if (name === "collection") return c
        const v = PARAM_VALUES[name]
        if (v == null) unresolved = true
        return v ?? "ci-render-probe"
      })
      out.push({ pattern, path: p, unresolved })
    }
  }
  return out
}

async function waitForServer(url, deadlineMs) {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: "manual" })
      if (r.status > 0) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server did not come up at ${url} within ${deadlineMs}ms`)
}

async function probe(target) {
  const t0 = Date.now()
  let url = BASE + target.path
  const hops = []
  try {
    // Follow same-origin redirects (canonicalisation, e.g. /<c>/moment/1 → /moment/1)
    // so a 307 is never scored as a render. A hop to /login is an auth gate: this
    // run cannot sign in, so the route is counted as GATED, not as passing.
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "rpc-built-render-smoke" },
      })
      const loc = r.headers.get("location")
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, url)
        hops.push(next.pathname)
        if (next.origin !== new URL(BASE).origin) {
          await r.body?.cancel()
          return { ...target, status: r.status, ms: Date.now() - t0, dsu: false, hops, external: true }
        }
        if (next.pathname === "/login") {
          await r.body?.cancel()
          return { ...target, status: r.status, ms: Date.now() - t0, dsu: false, hops, gated: true }
        }
        await r.body?.cancel()
        url = next.href
        continue
      }
      const body = await r.text()
      return { ...target, status: r.status, ms: Date.now() - t0, dsu: body.includes("DYNAMIC_SERVER_USAGE"), hops }
    }
    return { ...target, status: 0, ms: Date.now() - t0, dsu: false, hops, error: "redirect loop" }
  } catch (e) {
    return { ...target, status: 0, ms: Date.now() - t0, dsu: false, hops, error: String(e?.cause?.code || e?.name || e) }
  }
}

async function main() {
  if (!existsSync(MANIFEST)) {
    console.error(`✗ ${path.relative(ROOT, MANIFEST)} missing — run \`next build\` first.`)
    process.exit(2)
  }
  const patterns = Object.values(JSON.parse(readFileSync(MANIFEST, "utf8")))
  const collectionIds = registryCollectionIds(readFileSync(path.join(ROOT, "lib/collections.ts"), "utf8"))
  if (collectionIds.length < 5) {
    console.error(`✗ parsed only ${collectionIds.length} collection ids from lib/collections.ts — parser broke`)
    process.exit(2)
  }
  const targets = expandRoutes(patterns, collectionIds)
  const unresolved = [...new Set(targets.filter((t) => t.unresolved).map((t) => t.pattern))]
  if (unresolved.length) {
    // A new param name must get a deliberate placeholder, not a silent default.
    console.error(`✗ no PARAM_VALUES entry for: ${unresolved.join(", ")}`)
    process.exit(2)
  }
  if (process.argv.includes("--list")) {
    for (const t of targets) console.log(t.path)
    console.log(`${targets.length} urls from ${new Set(targets.map((t) => t.pattern)).size} page routes`)
    return
  }

  let server = null
  let serverLog = ""
  if (!EXTERNAL) {
    server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout.on("data", (d) => (serverLog += d))
    server.stderr.on("data", (d) => (serverLog += d))
  }
  let exitCode = 0
  try {
    await waitForServer(BASE + "/robots.txt", 60_000)
    const results = []
    let i = 0
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (i < targets.length) results.push(await probe(targets[i++]))
      }),
    )
    results.sort((a, b) => a.path.localeCompare(b.path))

    const dsuInLog = serverLog.includes("DYNAMIC_SERVER_USAGE")
    const bad = results.filter((r) => r.dsu || r.status === 0 || (r.status >= 500 && !KNOWN_5XX.has(r.pattern)))
    const healed = [...KNOWN_5XX.keys()].filter((p) => {
      const rs = results.filter((r) => r.pattern === p)
      return rs.length > 0 && rs.every((r) => r.status > 0 && r.status < 500)
    })
    const byStatus = {}
    for (const r of results) {
      const k = r.gated ? "login-gated" : r.external ? "external-redirect" : String(r.status)
      byStatus[k] = (byStatus[k] || 0) + 1
    }
    const rendered = results.filter((r) => !r.gated && !r.external && r.status >= 200 && r.status < 300).length

    // State the count inspected, every run — a guard that goes quiet has not passed.
    console.log(`built-render-smoke: ${results.length} urls · ${new Set(results.map((r) => r.pattern)).size} page routes · ${collectionIds.length} collections`)
    console.log(`  final status (after same-origin redirects): ${JSON.stringify(byStatus)}`)
    console.log(`  rendered 2xx: ${rendered}`)
    const slow = results.filter((r) => r.ms > 10_000)
    if (slow.length) console.log(`  slow (>10s): ${slow.map((r) => `${r.path} ${r.ms}ms`).join(", ")}`)
    for (const r of bad) {
      const why = r.dsu ? "DYNAMIC_SERVER_USAGE in body" : r.status === 0 ? `no response (${r.error})` : `HTTP ${r.status}`
      console.log(`  ✗ ${r.path}  [${r.pattern}]  ${why}`)
    }
    for (const p of healed) console.log(`  ✗ ${p} is in KNOWN_5XX but now answers < 500 everywhere — remove it`)
    if (dsuInLog) {
      const lines = serverLog.split("\n").filter((l) => /DYNAMIC_SERVER_USAGE|Route .* couldn't be rendered/.test(l))
      console.log(`  ✗ DYNAMIC_SERVER_USAGE in the server log:\n    ${lines.slice(0, 10).join("\n    ")}`)
    }
    // Not-vacuous: if almost nothing rendered (every route redirected to /login, or
    // 404'd on a placeholder) this run proved nothing and must not read as green.
    const floor = Math.floor(results.length / 3)
    if (rendered < floor) console.log(`  ✗ only ${rendered} urls rendered 2xx (floor ${floor}) — the smoke is not exercising pages`)
    if (bad.length || healed.length || dsuInLog || rendered < floor) {
      exitCode = 1
      if (server) console.log(`\n--- next start log (tail) ---\n${serverLog.split("\n").slice(-60).join("\n")}`)
    } else {
      console.log("  ✓ no 5xx, no DYNAMIC_SERVER_USAGE")
    }
  } finally {
    server?.kill("SIGTERM")
  }
  process.exit(exitCode)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e)
    process.exit(2)
  })
}
