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

/**
 * Workers whose ENTRY HANDLER (fetch/scheduled) is deliberately not drive-tested
 * — a token reference to the dir is not enough for these, so this is a stricter
 * opt-out than KNOWN_UNTESTED. Each needs a one-line reason. Currently none: all
 * 16 workers drive their handler (see __tests__/worker-*-handler / -routing /
 * -proxy suites). Being referenced only via a pure-submodule test (cdc/currency/
 * decode/parse) does NOT satisfy the entry-drive guard.
 */
const KNOWN_ENTRY_UNDRIVEN: Record<string, string> = {}

/** Candidate entry files for a worker dir, in priority order. */
const ENTRY_CANDIDATES = ["src/index.ts", "src/index.js", "index.ts", "index.js"]

function workerEntry(dir: string): string | null {
  for (const c of ENTRY_CANDIDATES) {
    if (existsSync(path.join(dir, c))) return c
  }
  return null
}

/** All test files' concatenated text (cheap: read once). */
/**
 * Every test file's text, read ONCE and reused.
 *
 * ⚠ An ARRAY, never a concatenation, and that distinction is load-bearing:
 * `entryIsDriven` requires the import AND a handler call **in the same file**.
 * Joining the corpus first would let an import in file A pair with a `.fetch(`
 * in file B and silently weaken the guard into a much easier check.
 */
let _testFilesCache: string[] | null = null
function testFileTexts(): string[] {
  if (_testFilesCache) return _testFilesCache
  const texts: string[] = []
  for (const entry of readdirSync(TESTS_DIR)) {
    if (!entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) continue
    texts.push(readFileSync(path.join(TESTS_DIR, entry), "utf8"))
  }
  _testFilesCache = texts
  return texts
}

function allTestText(): string {
  return testFileTexts().join("\n")
}

/**
 * True when SOME single test file both imports the worker's entry (its index)
 * AND invokes a handler (`.fetch(` / `.scheduled(`). That pairing — in one file —
 * is the behavioural-drive signal: a token dir reference or a pure-submodule
 * import (cdc/currency/decode/parse) does not count. Robust to name hyphens.
 */
export function entryIsDriven(workerName: string, texts: string[] = testFileTexts()): boolean {
  const importRe = new RegExp(`workers/${workerName}/(src/)?index`)
  // ⚡ Reads the corpus ONCE (cached) instead of re-reading every test file for
  // every worker. This was O(workers × testFiles) — ~17 × ~1,400 ≈ 24,000 reads —
  // which is why the arm grew from a measured 3.3 s (2026-08-24) to 21 s standalone
  // and began crossing even its raised 60 s timeout under full-suite load. The
  // per-file conjunction below is unchanged, so the assertion is identical.
  for (const txt of texts) {
    if (importRe.test(txt) && /\.(fetch|scheduled)\(/.test(txt)) return true
  }
  return false
}

describe("worker test-completeness rot-guard", () => {
  const workerDirs = readdirSync(WORKERS_DIR).filter((name) => {
    const full = path.join(WORKERS_DIR, name)
    return statSync(full).isDirectory()
  })

  it("finds worker directories (sanity)", () => {
    expect(workerDirs.length).toBeGreaterThan(10)
  })

  // ⚠ THE PER-FILE CONJUNCTION IS PINNED HERE, ON SYNTHETIC TEXT, and it has to
  // be: every worker is currently driven, so at a population of ZERO a loosening
  // of `entryIsDriven` is INVISIBLE to the tree-walking arm below. Mutation-tested
  // 2026-08-30 — dropping the `.fetch(`/`.scheduled(` half left that arm green.
  // The property is what matters, not today's offender count.
  describe("entryIsDriven requires the import AND a handler call IN THE SAME FILE", () => {
    it("accepts one file carrying both", () => {
      expect(entryIsDriven("demo", ['import w from "../workers/demo/index"\nawait w.fetch(req)'])).toBe(true)
      expect(entryIsDriven("demo", ['import w from "../workers/demo/src/index"\nawait w.scheduled(ev)'])).toBe(true)
    })

    it("REJECTS the halves split across two files", () => {
      // The exact weakening a concatenated corpus would introduce.
      expect(
        entryIsDriven("demo", ['import w from "../workers/demo/index"', "await other.fetch(req)"]),
      ).toBe(false)
    })

    it("REJECTS a bare reference with no handler drive", () => {
      expect(entryIsDriven("demo", ['import w from "../workers/demo/index"\nexpect(w).toBeTruthy()'])).toBe(false)
    })

    it("does not match a DIFFERENT worker's entry", () => {
      expect(entryIsDriven("demo", ['import w from "../workers/other/index"\nawait w.fetch(req)'])).toBe(false)
    })
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

  // Stricter than the reference check above: a worker's ENTRY handler must be
  // behaviourally driven, not just referenced by a pure-submodule test. This
  // locks in the 2026-08-01 worker-handler coverage pass so a future edit can't
  // silently drop a fetch()/scheduled() suite while leaving a submodule test in
  // place (which the reference guard would still accept).
  it("every worker's entry handler is drive-tested (imports index + calls .fetch()/.scheduled())", () => {
    const missing: string[] = []
    for (const name of workerDirs) {
      if (name in KNOWN_ENTRY_UNDRIVEN) continue
      const entry = workerEntry(path.join(WORKERS_DIR, name))
      if (!entry) continue // no logic entry → nothing to drive
      if (!entryIsDriven(name)) missing.push(name)
    }
    expect(
      missing,
      `These workers have an entry file but no test drives its handler. Add a ` +
        `worker.fetch()/scheduled() test (see __tests__/worker-*-handler.test.ts / ` +
        `-routing / -proxy) or add the worker to KNOWN_ENTRY_UNDRIVEN with a reason:\n  ` +
        `${missing.join("\n  ")}`,
    ).toEqual([])
    // ⚠ EXPLICIT TIMEOUT. This arm greps every worker test for a drive of each
    // worker's entry handler — ~3.3s of I/O standalone, which crosses vitest's 5s
    // DEFAULT under the full parallel run's load. Measured 2026-08-24: it failed at
    // 5236ms in one full run and passed the next, i.e. WHICH tree-scanning guard
    // reds is luck. A guard that reds for being SLOW is indistinguishable at a
    // glance from one that found something, and it trains the same skimming — the
    // lesson recorded in docs/reference/testing-and-ci.md the same day.
  }, 60_000)

  it("KNOWN_ENTRY_UNDRIVEN has no stale entries (allowlisted worker must still exist and lack an entry-drive)", () => {
    const stale: string[] = []
    for (const name of Object.keys(KNOWN_ENTRY_UNDRIVEN)) {
      const full = path.join(WORKERS_DIR, name)
      const exists = existsSync(full) && statSync(full).isDirectory()
      // Stale if the dir is gone, or its entry IS actually drive-tested now.
      if (!exists || entryIsDriven(name)) stale.push(name)
    }
    expect(
      stale,
      `Stale KNOWN_ENTRY_UNDRIVEN entries — the worker was deleted or is now ` +
        `drive-tested; remove it from the allowlist:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})
