import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The spork abort budget in `ingest-allday-pack-opens` has to fit inside pg_cron's
// `net.http_get` timeout, and the constraint is arithmetic rather than advisory.
//
// ── Why this is a test and not a comment ───────────────────────────────────
// Measured 2026-08-21: the spork caller aborts each attempt at 15 s while
// `workers/spork-proxy` allows ITSELF `REQUEST_TIMEOUT_MS = 25_000`, so the
// caller quits 10 s before the worker may answer — `status 0` on 40 of 42
// backfill runs / 72h. The obvious fix is to raise the caller's abort.
//
// ⚠ THE OBVIOUS VALUE IS THE ONE THAT BREAKS IT. The abort multiplies by the
// retry count, and pg_cron gives jobid 55 a 90 000 ms `net.http_get` budget for
// the WHOLE tick. `30 s x 3 tries` = 91.2 s, so no failing tick could ever return
// a response body again — which would blind `net._http_response`, the only
// instrument that diagnosed this in the first place. A fix that erases its own
// diagnostic is worse than the bug.
//
// This file makes that mechanical: raise the timeout without lowering the tries
// and CI reds, in the rotation window, before it deploys.
//
// ⚠ SOURCE-TEXT ASSERTION on purpose — the body is Deno and outside vitest/tsc,
// the same pattern as edge-cursor-throw-on-fetch-failure.test.ts.

const SRC = readFileSync(
  path.resolve(__dirname, "../supabase/functions/ingest-allday-pack-opens/index.ts"),
  "utf8",
)

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * also blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */
const CODE = stripComments(SRC)

/** A `const NAME = 12_345` literal, underscores allowed. */
function num(name: string): number {
  const m = CODE.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9_]+)`))
  expect(m, `${name} must be a named constant, not an inline literal`).not.toBeNull()
  return Number(m![1].replace(/_/g, ""))
}

// pg_cron jobid 55 (`rpc-allday-pack-opens-backfill`) passes
// timeout_milliseconds := 90000. Its twin jobid 20 (forward) carries the same.
const PG_NET_TIMEOUT_MS = 90_000

// `sleep(400 * a)` runs between attempts, so a=1..tries-1.
function backoffMs(tries: number): number {
  let t = 0
  for (let a = 1; a < tries; a++) t += 400 * a
  return t
}

describe("ingest-allday-pack-opens spork abort budget", () => {
  it("exposes the budget as named constants, not a shared inline literal", () => {
    // ⚠ The shape this replaced was ONE hardcoded 15000 inside j(), shared by
    // five call sites of which only two are spork. Editing it to fix the spork
    // lane also raised it for the healthy REST lane (jobid 20, p50 2.6 s) on the
    // same 90 s budget, for no benefit to that lane.
    expect(num("SPORK_TIMEOUT_MS")).toBeGreaterThan(0)
    expect(num("SPORK_TRIES")).toBeGreaterThan(0)
    expect(num("REST_TIMEOUT_MS")).toBeGreaterThan(0)
    expect(CODE).not.toMatch(/AbortSignal\.timeout\(\s*\d/)
  })

  it("the spork worst case leaves room for the rest of the tick", () => {
    const worst = num("SPORK_TIMEOUT_MS") * num("SPORK_TRIES") + backoffMs(num("SPORK_TRIES"))
    // ⚠ 75 s, not 90 s. pg_net's budget covers the WHOLE tick, and a tick issues
    // many event queries; a single failing query that eats 85 s of 90 s leaves
    // under 5 s for everything else and for the terminal pipeline_runs write.
    // The 15 s margin is the point of the assertion, not a rounding choice.
    expect(
      worst,
      `one failing spork query would consume ${worst} ms of pg_net's ${PG_NET_TIMEOUT_MS} ms ` +
        `budget. Raising SPORK_TIMEOUT_MS means lowering SPORK_TRIES — 28000x2 = 56400 fits, ` +
        `30000x3 = 91200 does not and would stop net._http_response ever recording a failing tick.`,
    ).toBeLessThanOrEqual(75_000)
  })

  it("only the two SPORK call sites take the spork budget", () => {
    // The REST call sites must keep the default. If they start passing
    // SPORK_TIMEOUT_MS the scoping is gone and the trap is back.
    const sporkCalls = [...CODE.matchAll(/j\(`\$\{SPORK_URL\}[^\n]*\)/g)].map((m) => m[0])
    expect(sporkCalls, "expected exactly the events + tx spork fetchers").toHaveLength(2)
    for (const c of sporkCalls) expect(c).toContain("SPORK_TIMEOUT_MS")
    expect(CODE.match(/SPORK_TIMEOUT_MS/g) ?? [], "declaration + exactly two call sites").toHaveLength(3)
  })

  it("this commit changed no behaviour — the scoped values still equal the old shared literal", () => {
    // ⚠ Pinned so the parameterisation cannot be mistaken for the fix. The value
    // decision belongs to the gate-key rotation window, which is the only window
    // in which this function can be deployed at all. Delete THIS case (not the
    // budget one above) when the real value ships.
    expect(num("SPORK_TIMEOUT_MS")).toBe(15_000)
    expect(num("REST_TIMEOUT_MS")).toBe(15_000)
    expect(num("SPORK_TRIES")).toBe(3)
  })

  it("the arithmetic helper matches the source's own backoff", () => {
    // Guards the guard: if sleep(400 * a) changes, this budget is wrong.
    expect(CODE).toContain("sleep(400 * a)")
    expect(backoffMs(3)).toBe(1200)
    expect(backoffMs(2)).toBe(400)
    expect(backoffMs(1)).toBe(0)
  })
})
