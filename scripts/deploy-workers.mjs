#!/usr/bin/env node
// scripts/deploy-workers.mjs — deploy Cloudflare workers from this checkout.
//
//   node scripts/deploy-workers.mjs                 # every worker with undeployed security changes (list below)
//   node scripts/deploy-workers.mjs dune-proxy ...  # just these
//
// Runs `npx wrangler deploy` in each workers/<name>/ directory, one at a time,
// stopping at the first failure. Needs a wrangler login on this machine
// (`npx wrangler login`) — the cloud sandbox has no Cloudflare credential, which
// is why these are deployed from Trevor's machine. rpc-mcp-proxy gets
// `--var BUILD_SHA:<short sha>` so /health shows which commit is live.
// Works in Git Bash, PowerShell and cmd (no shell syntax in the commands).
//
// ⭐ WHY THIS LIST (security audit 2026-10-25, register R138): written, tested and
// pushed that day, not yet deployed.
//   dune-proxy     — only RPC's own Dune query ids; `performance` no longer forwarded
//   helius-proxy   — only read-only DAS methods reach the keyed endpoint
//   spork-proxy    — no stack trace in a 500 body
//   rpc-mcp-proxy  — atomic per-call quota (mcp_reserve_tool_call), cached /health
//   every worker   — constant-time secret compares
// ⚠ A deploy ships EVERYTHING in workers/<name>/ at HEAD, not only these
// changes — check `git log -- workers/<name>` if a worker has other recent edits.
// The default target list is every worker with a wrangler.toml (all 16 carry the
// constant-time change).

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
const WORKERS = path.join(ROOT, "workers")

const ALL = readdirSync(WORKERS).filter((d) => existsSync(path.join(WORKERS, d, "wrangler.toml")))

const requested = process.argv.slice(2)
const targets = requested.length ? requested : ALL
const unknown = targets.filter((t) => !existsSync(path.join(WORKERS, t, "wrangler.toml")))
if (unknown.length) {
  console.error(`unknown worker(s): ${unknown.join(", ")}`)
  process.exit(2)
}

const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()
console.log(`deploying ${targets.length} worker(s) from ${sha || "unknown commit"}: ${targets.join(", ")}`)

for (const name of targets) {
  const dir = path.join(WORKERS, name)
  // Workers with their own dependencies (pack-events-ingest, rpc-mcp-proxy …)
  // bundle from their OWN node_modules; install once if it is missing.
  if (existsSync(path.join(dir, "package.json")) && !existsSync(path.join(dir, "node_modules"))) {
    console.log(`── ${name}: npm install`)
    const i = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" })
    if (i.status !== 0) {
      console.error(`\n✗ ${name}: npm install failed (exit ${i.status}). Stopping.`)
      process.exit(i.status ?? 1)
    }
  }
  const args = ["wrangler", "deploy"]
  if (name === "rpc-mcp-proxy" && sha) args.push("--var", `BUILD_SHA:${sha}`)
  console.log(`\n── ${name}: npx ${args.join(" ")}`)
  const r = spawnSync("npx", args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" })
  if (r.status !== 0) {
    console.error(`\n✗ ${name} failed (exit ${r.status}). Stopping; the workers above it are deployed.`)
    process.exit(r.status ?? 1)
  }
  console.log(`✓ ${name}`)
}
console.log(`\n✓ all ${targets.length} deployed from ${sha}`)
