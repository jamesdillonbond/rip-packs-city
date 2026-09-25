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
// WHAT IT RUNS AGAINST. CI builds with placeholder env and points Supabase at a
// local STUB this script starts (NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<port>).
// The stub drops every data connection, so every read FAILS FAST exactly as if
// the database were unreachable. That is on purpose — it makes this the
// platform's failed-read path, rendered for real:
//   • a page must answer < 500 (an honest degraded state or a 404 is fine);
//   • a 5xx is a page that turns an unreachable DB into a crash;
//   • `DYNAMIC_SERVER_USAGE` anywhere (body or server log) fails regardless.
// A route handler under /api/** is out of scope — many are gated or POST-only,
// and `lib/api-error.ts` already owns their 5xx contract (a 503 there is honest).
//
// TWO PASSES. Pass 1 is anonymous. Every URL that pass 1 saw bounce to /login is
// then re-requested SIGNED IN (pass 2): the stub answers exactly the two calls
// proxy.ts makes to admit a user — `GET /auth/v1/user` for the test session's
// token, and `rpc/check_email_allowed` → true — and still drops everything else.
// So pass 2 renders the signed-in failed-read path of the gated pages, which
// were invisible to pass 1 (86 of 314 URLs on 2026-09-25). The stub is a TEST
// double on 127.0.0.1 inside the CI job; nothing in the app trusts it.
//
// ⚠ It is NOT a data check and cannot see a wrong number; it sees a render that
// cannot happen. Known 5xx routes live in KNOWN_5XX with a reason — the ratchet
// fails when one starts answering < 500 too, so the list can only shrink.
//
// Usage:
//   node scripts/qa/built-render-smoke.mjs            # spawns the stub + `next start` on :3137
//   BASE_URL=http://localhost:3000 node scripts/qa/built-render-smoke.mjs   # anon pass only
//   node scripts/qa/built-render-smoke.mjs --list     # print the URL set, no requests

import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import http from "node:http"
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
  [
    "/edition/[id]",
    "2026-09-25: BY DESIGN. The legacy /edition/<uuid> redirect THROWS on a failed lookup so the " +
      "retryable error boundary renders instead of a false 404 for an edition that exists " +
      "(app/edition/[id]/page.tsx). A 500 there is the honest failed-read state, not a crash.",
  ],
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

// Per-ROUTE placeholders, where a route validates its param's FORMAT before it
// reads (a UUID_RE check → notFound()). The generic "1" would stop those at the
// format check and never reach the failed-read path this smoke exists to render.
const PATTERN_PARAM_VALUES = {
  "/edition/[id]": { id: "00000000-0000-4000-8000-000000000001" },
  "/analytics/sets/[set_id]": { set_id: "00000000-0000-4000-8000-000000000001" },
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
        const v = PATTERN_PARAM_VALUES[pattern]?.[name] ?? PARAM_VALUES[name]
        if (v == null) unresolved = true
        return v ?? "ci-render-probe"
      })
      out.push({ pattern, path: p, unresolved })
    }
  }
  return out
}

/** Concrete page paths Next prerendered (generateStaticParams). Adds the routes
 * whose `[collection]` uses its OWN slug list (/analytics/sales/topshot) — the
 * registry expansion 404s on those, so without this they were never rendered. */
export function prerenderedPaths(prerenderManifest) {
  return Object.keys(prerenderManifest.routes ?? {}).filter(
    (p) => !p.startsWith("/api") && !p.startsWith("/_") && !p.slice(1).includes(".") && p !== "/index",
  )
}

/** Merge prerendered concrete paths into the expanded targets, keyed on path. Pure. */
export function withPrerendered(targets, paths) {
  const seen = new Set(targets.map((t) => t.path))
  const extra = paths.filter((p) => !seen.has(p)).sort().map((p) => ({ pattern: `${p} (prerendered)`, path: p, unresolved: false }))
  return [...targets, ...extra]
}

// ── The signed-in test identity ──────────────────────────────────────────────
const b64url = (s) => Buffer.from(s).toString("base64url")
const FAR = 4_102_444_800 // 2100-01-01, seconds
export const TEST_USER = {
  id: "00000000-0000-4000-8000-00000000c1c1",
  aud: "authenticated",
  role: "authenticated",
  email: "render-smoke@example.invalid",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: "2026-09-25T00:00:00Z",
}
// JWT-SHAPED but unsigned: only the stub below ever sees it, and the stub is the
// thing that "verifies" it. auth-js decodes the payload for expiry, hence the shape.
export const TEST_ACCESS_TOKEN = [
  b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  b64url(JSON.stringify({ sub: TEST_USER.id, email: TEST_USER.email, role: "authenticated", aud: "authenticated", exp: FAR })),
  "render-smoke",
].join(".")

/** The @supabase/ssr session cookie for a given project URL. Pure. */
export function sessionCookie(supabaseUrl) {
  const ref = new URL(supabaseUrl).hostname.split(".")[0]
  const session = {
    access_token: TEST_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: FAR,
    refresh_token: "render-smoke-refresh",
    user: TEST_USER,
  }
  return `sb-${ref}-auth-token=base64-${b64url(JSON.stringify(session))}`
}

/** Local Supabase stand-in: admits the test session, fails every data read. */
export function startStubSupabase(port) {
  const hits = { user: 0, allow: 0, dropped: 0, rejectedToken: 0 }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub")
    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      if (req.headers.authorization === `Bearer ${TEST_ACCESS_TOKEN}`) {
        hits.user++
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify(TEST_USER))
      }
      hits.rejectedToken++
      res.writeHead(401, { "content-type": "application/json" })
      return res.end(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }))
    }
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/check_email_allowed") {
      hits.allow++
      res.writeHead(200, { "content-type": "application/json" })
      return res.end("true")
    }
    // Everything else is a data read: drop the connection, the same failure the
    // client sees from an unreachable host.
    hits.dropped++
    req.socket.destroy()
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve({ server, hits }))
  })
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

async function probe(target, cookie) {
  const t0 = Date.now()
  let url = BASE + target.path
  const hops = []
  const headers = { "user-agent": "rpc-built-render-smoke" }
  if (cookie) headers.cookie = cookie
  try {
    // Follow same-origin redirects (canonicalisation, e.g. /<c>/moment/1 → /moment/1)
    // so a 307 is never scored as a render. A hop to /login is an auth gate: it is
    // counted as GATED, never as passing.
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers })
      const loc = r.headers.get("location")
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, url)
        hops.push(next.pathname + next.search)
        await r.body?.cancel()
        if (next.origin !== new URL(BASE).origin) {
          return { ...target, status: r.status, ms: Date.now() - t0, dsu: false, hops, external: true }
        }
        if (next.pathname === "/login") {
          return { ...target, status: r.status, ms: Date.now() - t0, dsu: false, hops, gated: true }
        }
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

async function runAll(targets, cookie) {
  const results = []
  let i = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < targets.length) results.push(await probe(targets[i++], cookie))
    }),
  )
  return results.sort((a, b) => a.path.localeCompare(b.path))
}

/** Score one pass. Pure. */
export function score(results) {
  const bad = results.filter((r) => r.dsu || r.status === 0 || (r.status >= 500 && !KNOWN_5XX.has(r.pattern)))
  const byStatus = {}
  for (const r of results) {
    const k = r.gated ? "login-gated" : r.external ? "external-redirect" : String(r.status)
    byStatus[k] = (byStatus[k] || 0) + 1
  }
  const rendered = results.filter((r) => !r.gated && !r.external && r.status >= 200 && r.status < 300).length
  return { bad, byStatus, rendered }
}

function report(label, results, s) {
  console.log(`  ${label}: ${results.length} urls · final status ${JSON.stringify(s.byStatus)} · rendered 2xx ${s.rendered}`)
  const slow = results.filter((r) => r.ms > 10_000)
  if (slow.length) console.log(`    slow (>10s): ${slow.map((r) => `${r.path} ${r.ms}ms`).join(", ")}`)
  for (const r of s.bad) {
    const why = r.dsu ? "DYNAMIC_SERVER_USAGE in body" : r.status === 0 ? `no response (${r.error})` : `HTTP ${r.status}`
    console.log(`    ✗ ${r.path}  [${r.pattern}]  ${why}`)
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
  const prerenderPath = path.join(ROOT, ".next", "prerender-manifest.json")
  const prerendered = existsSync(prerenderPath) ? prerenderedPaths(JSON.parse(readFileSync(prerenderPath, "utf8"))) : []
  const targets = withPrerendered(expandRoutes(patterns, collectionIds), prerendered)
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

  // The stub runs only when this script owns the server: it must sit at the
  // Supabase URL the BUILD inlined, which only a local build can promise.
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  let stub = null
  if (!EXTERNAL) {
    const u = new URL(supaUrl || "http://invalid")
    if (u.hostname !== "127.0.0.1" || !u.port) {
      console.error(`✗ NEXT_PUBLIC_SUPABASE_URL must be http://127.0.0.1:<port> (the stub's address); got ${supaUrl || "(unset)"}`)
      process.exit(2)
    }
    stub = await startStubSupabase(Number(u.port))
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
    const anon = await runAll(targets)
    const anonScore = score(anon)

    // Pass 2 — the gated URLs, signed in.
    const gatedTargets = anon.filter((r) => r.gated).map(({ pattern, path: p }) => ({ pattern, path: p }))
    const signedIn = stub && gatedTargets.length ? await runAll(gatedTargets, sessionCookie(supaUrl)) : []
    const signedScore = score(signedIn)
    const stillGated = signedIn.filter((r) => r.gated)

    const all = [...anon, ...signedIn]
    const healed = [...KNOWN_5XX.keys()].filter((p) => {
      const rs = all.filter((r) => r.pattern === p && !r.gated)
      return rs.length > 0 && rs.every((r) => r.status > 0 && r.status < 500)
    })
    const dsuInLog = serverLog.includes("DYNAMIC_SERVER_USAGE")

    // State the count inspected, every run — a guard that goes quiet has not passed.
    console.log(`built-render-smoke: ${anon.length} urls (${targets.filter((t) => t.pattern.endsWith("(prerendered)")).length} of them prerendered paths the route expansion missed) · ${collectionIds.length} collections`)
    report("anonymous", anon, anonScore)
    if (stub) {
      report("signed in (gated urls)", signedIn, signedScore)
      console.log(`    stub: ${JSON.stringify(stub.hits)}`)
    } else {
      console.log("  signed in: SKIPPED — BASE_URL is external, so no stub sits behind it")
    }
    for (const p of healed) console.log(`  ✗ ${p} is in KNOWN_5XX but now answers < 500 everywhere — remove it`)
    if (dsuInLog) {
      const lines = serverLog.split("\n").filter((l) => /DYNAMIC_SERVER_USAGE|Route .* couldn't be rendered/.test(l))
      console.log(`  ✗ DYNAMIC_SERVER_USAGE in the server log:\n    ${lines.slice(0, 10).join("\n    ")}`)
    }
    // Not-vacuous: if almost nothing rendered this run proved nothing.
    const floor = Math.floor(anon.length / 3)
    const fails = []
    if (anonScore.rendered < floor) fails.push(`only ${anonScore.rendered} urls rendered 2xx anonymously (floor ${floor})`)
    // A valid, allowlisted session that still lands on /login means the signed-in
    // pass is not admitting anyone — it would be checking nothing.
    if (stillGated.length) {
      fails.push(`${stillGated.length} gated url(s) still bounce to /login when signed in: ${stillGated.slice(0, 5).map((r) => `${r.path} → ${r.hops.at(-1)}`).join(", ")}`)
    }
    if (stub && gatedTargets.length && stub.hits.user === 0) fails.push("the stub never served /auth/v1/user — no request was signed in")
    for (const f of fails) console.log(`  ✗ ${f}`)
    if (anonScore.bad.length || signedScore.bad.length || healed.length || dsuInLog || fails.length) {
      exitCode = 1
      if (server) console.log(`\n--- next start log (tail) ---\n${serverLog.split("\n").slice(-60).join("\n")}`)
    } else {
      console.log("  ✓ no 5xx, no DYNAMIC_SERVER_USAGE")
    }
  } finally {
    server?.kill("SIGTERM")
    stub?.server.close()
  }
  process.exit(exitCode)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e)
    process.exit(2)
  })
}
