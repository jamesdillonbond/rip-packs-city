import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * 2026-10-27: every wallet-backfill route called record_wallet_backfill_scan after EVERY run, so a failed
 * walk (29 UFC walks on a Flow 429, 10-26) stamped `wallet_backfill_state.last_scanned_at = now()` with
 * `last_found_count = 0`. Readers take that row as a measurement: check_wmc_ownership_freshness ("fully
 * re-enumerated"), reconcile_allow_list_prewarm ("reconciled_empty"), golazos-discover-buyers ("scanned —
 * never select again"). The walkers now return `scanned` (BackfillRunResult.scanned) and a route may record
 * a scan only when it is true.
 *
 * Population: DERIVED — every route.ts under app/api that names record_wallet_backfill_scan — so a new
 * caller is enrolled by existing. Property: the file reads a `scanned` result and the RPC call sits inside
 * an `if (...scanned)` block (or is reached only through one).
 */

const API = join(process.cwd(), "app/api")

function routes(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routes(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

const callers = routes(API)
  .map((p) => ({ p, src: readFileSync(p, "utf8") }))
  .filter(({ src }) => src.includes('"record_wallet_backfill_scan"'))

describe("a wallet scan is recorded only when the walk scanned", () => {
  it("the population is real (the guard is not vacuous)", () => {
    // ufc, golazos, pinnacle, and the Top Shot walker (via its recordScan helper) on 2026-10-27.
    expect(callers.length).toBeGreaterThanOrEqual(4)
  })

  it.each(callers.map((c) => [c.p.slice(process.cwd().length + 1), c.src]))("%s gates the record on `scanned`", (_p, src) => {
    const text = src as string
    // Every RPC call site must be preceded, within its enclosing block, by an `if (` naming `scanned`.
    let from = 0
    let sites = 0
    for (;;) {
      const at = text.indexOf('rpc("record_wallet_backfill_scan"', from)
      if (at < 0) break
      sites++
      from = at + 1
      const before = text.slice(Math.max(0, at - 600), at)
      const fnDef = before.lastIndexOf("async function recordScan")
      if (fnDef >= 0) {
        // A helper: every CALL of the helper must be gated instead.
        const calls = [...text.matchAll(/await recordScan\(/g)]
        expect(calls.length).toBeGreaterThan(0)
        for (const m of calls) {
          const line = text.slice(text.lastIndexOf("\n", m.index!) + 1, m.index!)
          expect(line).toMatch(/if \([^)]*scanned[^)]*\)/)
        }
        continue
      }
      expect(before).toMatch(/if \([^)]*scanned\)\s*\{[^}]*$/)
    }
    expect(sites).toBeGreaterThan(0)
  })
})
