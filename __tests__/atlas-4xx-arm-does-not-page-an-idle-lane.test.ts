import { describe, it, expect } from "vitest"
import { migrationFiles } from "./helpers/migration-defs"

// `check_edge_fn_http_failures()` escalates an Atlas lane's 403 row to `high` when the lane has not
// answered 200 lately. On 10-25 that paged HIGH for the member-username lane after it had simply
// dispatched NOTHING for 7 h (no wallet to resolve): the first request after the idle spell caught
// the routine ~5-15 % Cloudflare challenge, and "no 200 in 6 h" read true. IDLE and BLOCKED looked the
// same. 20261025164733 made the usernames and autograph arms also require 3+ failed responses since
// the newest 200.
//
// The arm is built by splicing branch text into the live body, so the property is checked per branch
// TEXT: every severity rule of the form `(SELECT max(drained_at) … WHERE status_code = 200) < now() -
// interval …` in a splice migration from 20261025164733 on must carry the consecutive-failure clause
// (`status_code IS DISTINCT FROM 200`) in the same CASE. Earlier migrations hold the old anchors the
// fix replaced, so they are not the population.

const FIX = "20261025164733"
const ARM = /check_edge_fn_http_failures/
const STALE_200 =
  /CASE\s+WHEN\s+\(*\s*\(SELECT\s+max\(drained_at\)\s+FROM\s+public\.([a-z0-9_]+)\s+WHERE\s+status_code\s*=\s*200\)[\s\S]*?THEN\s+'high'\s+ELSE\s+'info'\s+END/gi

function rules() {
  const out: Array<{ file: string; table: string; guarded: boolean }> = []
  for (const f of migrationFiles()) {
    if (f.name.slice(0, FIX.length) < FIX || !ARM.test(f.src)) continue
    for (const m of f.src.matchAll(STALE_200)) {
      if (!/<\s*now\(\)\s*-\s*interval/i.test(m[0])) continue
      out.push({ file: f.name, table: m[1], guarded: /status_code\s+IS\s+DISTINCT\s+FROM\s+200/i.test(m[0]) })
    }
  }
  return out
}

describe("the 4xx arm does not page HIGH for an Atlas lane that was merely idle", () => {
  const all = rules()

  it("inspects the fix's own rules (positive control)", () => {
    const fix = all.filter((r) => r.file.startsWith(FIX)).map((r) => r.table)
    expect(fix).toContain("member_wallet_username_requests")
    expect(fix).toContain("autograph_sweep_requests")
  })

  it("every 'no 200 lately' escalation also requires consecutive failures", () => {
    // The fix file holds the OLD anchors too (as the text it replaces), so read only the rules it
    // writes: an unguarded rule in the fix file is expected exactly once per guarded one.
    const fixFile = all.filter((r) => r.file.startsWith(FIX))
    expect(fixFile.filter((r) => r.guarded).length).toBe(2)
    const later = all.filter((r) => !r.file.startsWith(FIX))
    expect(later.filter((r) => !r.guarded), JSON.stringify(later)).toEqual([])
  })
})
