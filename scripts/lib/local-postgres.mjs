// scripts/lib/local-postgres.mjs
//
// A throwaway Postgres for the two SQL gates that, until 2026-10-20, ran ONLY in
// CI: the migration parse check (scripts/check-migration-sql-parses.sh) and the
// DB-invariant suite (scripts/run-db-tests.sh). preflight never ran either, so a
// migration with a syntax error reached `main` on 10-19 (20261020044118, line 66)
// and CI stayed red across ~5 pushes before anyone fixed it.
//
// It provisions exactly what CI does — a bare `initdb`, nothing pre-created (⚠ do
// NOT add `CREATE EXTENSION unaccent` here: the test files provision it into the
// `extensions` schema themselves, and pre-creating it breaks three of them —
// tooling-gotchas.md, "initdb refuses to run as root").
//
// Two traps this handles, both measured in this repo's sandboxes:
//   · `initdb` hard-refuses root. As root, everything runs as the `postgres` user.
//   · that user cannot read a /tmp/claude-* scratch dir, so the cluster lives in a
//     fresh /var/tmp directory it owns.
//
// Returns null — never throws — when no Postgres is installed (Trevor's Windows
// box), so the caller can NAME the gate as not run instead of failing or, worse,
// passing silently.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, chownSync } from "node:fs"
import { join } from "node:path"

/** The directory holding initdb/pg_ctl, or null. PATH first, then Debian's layout. */
export function findPgBin() {
  const onPath = spawnSync("sh", ["-c", "command -v pg_ctl"], { encoding: "utf8" })
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim().replace(/\/pg_ctl$/, "")
  const root = "/usr/lib/postgresql"
  if (!existsSync(root)) return null
  const versions = readdirSync(root).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a))
  for (const v of versions) if (existsSync(join(root, v, "bin", "pg_ctl"))) return join(root, v, "bin")
  return null
}

function uidOf(user) {
  try {
    return Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim())
  } catch {
    return null
  }
}

/**
 * Start a scratch cluster. Returns { url, stop } or { error } — never throws.
 * `url` is a superuser connection (both scripts need CREATE DATABASE).
 */
export function startScratchPostgres() {
  if (process.platform === "win32") return { error: "no local Postgres on Windows" }
  const bin = findPgBin()
  if (!bin) return { error: "no Postgres binaries found (pg_ctl not on PATH, no /usr/lib/postgresql/*/bin)" }

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0
  const pgUid = asRoot ? uidOf("postgres") : null
  if (asRoot && pgUid == null) return { error: "running as root and there is no `postgres` user to run initdb as" }

  const dir = mkdtempSync(join(existsSync("/var/tmp") ? "/var/tmp" : "/tmp", "rpc-preflight-pg-"))
  if (asRoot) chownSync(dir, pgUid, Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim()))
  const data = join(dir, "data")
  const port = 20000 + Math.floor(Math.random() * 20000)
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`
  const run = (cmd) =>
    asRoot
      ? spawnSync("su", ["postgres", "-s", "/bin/sh", "-c", cmd], { encoding: "utf8" })
      : spawnSync("sh", ["-c", cmd], { encoding: "utf8" })

  // Errors are CAPTURED and returned, never piped to /dev/null: a silenced initdb
  // failure leaves nothing but a dead port, which is how this cost time on 08-22.
  const init = run(`${q(bin + "/initdb")} -D ${q(data)} -U postgres --auth=trust -E UTF8 --no-locale`)
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    return { error: `initdb failed: ${(init.stderr || init.stdout).trim().split("\n").slice(-2).join(" | ")}` }
  }
  const start = run(`${q(bin + "/pg_ctl")} -D ${q(data)} -o ${q(`-p ${port} -k ${dir} -c listen_addresses=''`)} -l ${q(join(dir, "pg.log"))} -w start`)
  if (start.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    return { error: `pg_ctl start failed: ${(start.stderr || start.stdout).trim().split("\n").slice(-2).join(" | ")}` }
  }
  const stop = () => {
    run(`${q(bin + "/pg_ctl")} -D ${q(data)} -m immediate stop`)
    rmSync(dir, { recursive: true, force: true })
  }
  return { url: `postgres://postgres@/postgres?host=${encodeURIComponent(dir)}&port=${port}`, stop }
}
