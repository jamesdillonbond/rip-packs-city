import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync, existsSync } from "fs"
import path from "path"

// ── Worker test-completeness rot-guard ──────────────────────────────────────
//
// The Cloudflare Workers under workers/** are the platform's paid-egress
// proxies + ingest relays (TopShot/AllDay GraphQL, Solana/Base/Flow-EVM RPC,
// Dune, Reddit, sports/odds, HybridCustody, pack-events, sales-counterparty).
// A dropped auth check or mis-route in one is an open relay or silently-wrong
// data — and NEITHER coverage gate measures workers/** (the primary gate is
// lib/** + app/api/**/route.ts; the component gate is components/**), so a NEW
// worker could land with zero tests and nothing would redden CI.
//
// Every worker with an entry file must be referenced by at least one test file
// (the worker.fetch(request, env) harness pattern). A new untested worker fails
// this test — forcing a conscious "test it or justify skipping it" decision
// instead of silent rot. This mirrors component-gate-include-completeness.test.
//
// Opt a worker out (rarely — e.g. a pure config/asset dir with no logic) by
// adding it to KNOWN_UNTESTED with a one-line reason.

const ROOT = path.resolve(__dirname, "..")
const WORKERS_DIR = path.join(ROOT, "workers")
const TESTS_DIR = __dirname

/** Workers deliberately left without a test, each with a reason. Currently none. */
const KNOWN_UNTESTED: Record<string, string> = {}

/** Candidate entry files for a worker dir, in priority order. */
const ENTRY_CANDIDATES = ["src/index.ts", "src/index.js", "index.ts", "index.js"]

function workerEntry(dir: string): string | null {
  for (const c of ENTRY_CANDIDATES) {
    if (existsSync(path.join(dir, c))) return c
  }
  return null
}

/** All test files' concatenated text (cheap: read once). */
function allTestText(): string {
  const parts: string[] = []
  for (const entry of readdirSync(TESTS_DIR)) {
    if (!entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) continue
    parts.push(readFileSync(path.join(TESTS_DIR, entry), "utf8"))
  }
  return parts.join("\n")
}

describe("worker test-completeness rot-guard", () => {
  const workerDirs = readdirSync(WORKERS_DIR).filter((name) => {
    const full = path.join(WORKERS_DIR, name)
    return statSync(full).isDirectory()
  })

  it("finds worker directories (sanity)", () => {
    expect(workerDirs.length).toBeGreaterThan(10)
  })

  it("every worker with an entry file is referenced by a test (or explicitly allowlisted)", () => {
    const testText = allTestText()
    const missing: string[] = []
    for (const name of workerDirs) {
      if (name in KNOWN_UNTESTED) continue
      const entry = workerEntry(path.join(WORKERS_DIR, name))
      if (!entry) continue // no logic entry → nothing to test
      // A test references a worker by its path substring, e.g. "workers/topshot-proxy".
      if (!testText.includes(`workers/${name}`)) {
        missing.push(name)
      }
    }
    expect(
      missing,
      `These workers have an entry file but no test references them. Either add a ` +
        `worker.fetch() test (see __tests__/worker-*.test.ts) or add the worker to ` +
        `KNOWN_UNTESTED with a reason:\n  ${missing.join("\n  ")}`,
    ).toEqual([])
  })

  it("KNOWN_UNTESTED has no stale entries (allowlisted worker must still exist and lack a test)", () => {
    const testText = allTestText()
    const stale: string[] = []
    for (const name of Object.keys(KNOWN_UNTESTED)) {
      const full = path.join(WORKERS_DIR, name)
      const exists = existsSync(full) && statSync(full).isDirectory()
      // Stale if the dir is gone, or it IS actually referenced by a test now.
      if (!exists || testText.includes(`workers/${name}`)) stale.push(name)
    }
    expect(
      stale,
      `Stale KNOWN_UNTESTED entries — the worker was deleted or is now tested; ` +
        `remove it from the allowlist:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})
