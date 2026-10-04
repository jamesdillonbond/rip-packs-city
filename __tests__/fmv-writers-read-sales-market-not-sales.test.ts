// Every FMV writer reads public.sales_market — sales minus issuer buy-backs —
// never public.sales (known-issues #169, 2026-10-03).
//
// A Dapper sell-back is the issuer buying at ITS OWN offer, not collector price
// discovery. Until #169 the FMV writers counted them: 64 Top Shot editions that
// traded ONLY via sell-backs carried MEDIUM/LOW FMVs. The fix is one view
// (`sales_market`, resolving through the `buyback_wallets` registry); this guard
// keeps a NEW or re-created writer from quietly going back to `sales`.
//
// POPULATION (a tree walk, not a list): the NEWEST definition of every SQL
// function in supabase/migrations — skipping any dropped after it — whose name
// contains `fmv` or whose body INSERTs into fmv_snapshots / edition_fmv_estimates,
// plus every app/api/fmv-* route. SUPPRESSION is the curated list: each entry is
// a claim that raw `sales` is RIGHT there, with the reason.
//
// SQL comments are stripped here with a `--` line rule (scripts/lib/strip-comments.mjs
// handles JS comments only); the TS routes use the shared stripper.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const MIG_DIR = "supabase/migrations"
const RAW_SALES = /\b(from|join)\s+(public\.)?sales\b(?!_)/i
const MARKET = /\b(from|join)\s+public\.sales_market\b/i

// fn -> why reading raw `sales` is correct there
const SUPPRESSED: Record<string, string> = {
  fmv_recalc_edition_page:
    "selector: picks which editions to re-price; a buy-back-only edition must STAY in the set so its FMV is re-derived without the buy-backs",
  fmv_recalc_90d_catchup_editions: "selector: same reason as fmv_recalc_edition_page",
  fmv_backfill_candidates: "selector: editions with sales but no snapshot; the backfill then prices from sales_market",
  topshot_fmv_backtest: "yardstick: excludes 0xe1f2… explicitly in its own predicate (it measures against realized sales)",
  fmv_sales_backtest: "yardstick: excludes 0xe1f2… explicitly in its own predicate",
  get_wallet_moments_with_fmv: "display read for a wallet page, not an FMV writer",
}

const FMV_ROUTES = ["app/api/fmv-recalc/route.ts", "app/api/fmv-backfill/route.ts"]

type Def = { file: string; body: string; dropped: boolean }

function newestDefinitions(): Map<string, Def> {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
  const defs = new Map<string, Def>()
  const create = /^[ \t]*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gim
  const drop = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
  for (const f of files) {
    const src = readFileSync(join(MIG_DIR, f), "utf8")
    // a DROP (outside a comment line) retires every earlier definition of that name
    const live = src.replace(/--[^\n]*/g, "")
    for (const m of live.matchAll(drop)) {
      const d = defs.get(m[1])
      if (d) d.dropped = true
    }
    for (const m of src.matchAll(create)) {
      const after = src.slice((m.index ?? 0) + m[0].length)
      const tag = /AS\s+(\$[A-Za-z_]*\$)/i.exec(after)
      if (!tag) continue
      const start = tag.index + tag[0].length
      const end = after.indexOf(tag[1], start)
      if (end < 0) continue
      defs.set(m[1], { file: f, body: after.slice(start, end), dropped: false })
    }
  }
  return defs
}

const stripSql = (b: string) => b.replace(/--[^\n]*/g, "")

function population(defs: Map<string, Def>): string[] {
  const out: string[] = []
  for (const [fn, d] of defs) {
    if (d.dropped) continue
    const body = stripSql(d.body)
    const writes = /\binsert\s+into\s+(public\.)?(fmv_snapshots|edition_fmv_estimates)\b/i.test(body)
    if (fn.includes("fmv") || writes) out.push(fn)
  }
  return out.sort()
}

describe("FMV writers read sales_market, never raw sales (#169)", () => {
  const defs = newestDefinitions()
  const pop = population(defs)

  it("inspects a real population (the walk found functions and the FMV writers among them)", () => {
    expect(defs.size).toBeGreaterThan(400)
    expect(pop.length).toBeGreaterThan(20)
    // the writers #169 repointed are in the population and read the view
    for (const fn of ["drain_fmv_cold_tail", "fmv_recalc_historical_candidates", "fmv_clamp_disconnected_ask",
                      "compute_serial_fmv_multipliers", "refresh_topshot_thin_fmv_editions"]) {
      expect(pop).toContain(fn)
      expect(stripSql(defs.get(fn)!.body)).toMatch(MARKET)
    }
  })

  it("no un-suppressed FMV function reads raw sales", () => {
    const offenders = pop.filter((fn) => !(fn in SUPPRESSED) && RAW_SALES.test(stripSql(defs.get(fn)!.body)))
    expect(offenders).toEqual([])
  })

  it("every suppression still names a live function that still reads raw sales (no stale entries)", () => {
    for (const fn of Object.keys(SUPPRESSED)) {
      const d = defs.get(fn)
      expect(d, fn).toBeDefined()
      expect(d!.dropped, fn).toBe(false)
      expect(RAW_SALES.test(stripSql(d!.body)), fn).toBe(true)
    }
  })

  it("a dropped function is not a reader (fmv_clamp_disconnected_ask_topshot was dropped 2026-08-04)", () => {
    expect(defs.get("fmv_clamp_disconnected_ask_topshot")?.dropped).toBe(true)
    expect(pop).not.toContain("fmv_clamp_disconnected_ask_topshot")
  })

  it("the FMV routes read sales_market and never .from(\"sales\")", () => {
    for (const f of FMV_ROUTES) {
      expect(existsSync(f), f).toBe(true)
      const code = stripComments(readFileSync(f, "utf8"))
      expect(code, f).not.toMatch(/\.from\(\s*["'`]sales["'`]\s*\)/)
      expect(code, f).toMatch(/\.from\(\s*["'`]sales_market["'`]\s*\)/)
    }
  })

  // A function that HAND-LISTS system wallets to filter buyers (the Dapper merchant 0xc1e4… is in
  // every such list) is making a buyer-identity judgement, so it must also apply the registry's
  // buy-back exclusion — through sales_market or buyback_wallets — instead of hoping its own list
  // is complete. Eight such lists lacked Dapper's buy-back wallet until 2026-10-03 (#169).
  it("every function that hand-filters system-wallet buyers also excludes the buy-back registry", () => {
    const READS = /\b(from|join)\s+(public\.)?sales(_market)?\b(?!_)/i
    const handListers = [...defs].filter(([, d]) => !d.dropped)
      .map(([fn, d]) => [fn, stripSql(d.body)] as const)
      .filter(([, b]) => b.includes("0xc1e4f4f4c4257510") && READS.test(b))
    expect(handListers.length).toBeGreaterThanOrEqual(8)
    const offenders = handListers
      .filter(([, b]) => RAW_SALES.test(b) && !/\bbuyback_wallets\b/.test(b))
      .map(([fn]) => fn)
    expect(offenders).toEqual([])
  })

  it("the view resolves through the buyback_wallets registry, keeps NULL buyers, and is service-role only", () => {
    const viewFile = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
      .filter((f) => /CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.sales_market\b/i.test(readFileSync(join(MIG_DIR, f), "utf8")))
      .pop()
    expect(viewFile).toBeDefined()
    const src = stripSql(readFileSync(join(MIG_DIR, viewFile!), "utf8"))
    const view = /CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.sales_market[\s\S]*?;/i.exec(src)![0]
    expect(view).toMatch(/security_invoker\s*=\s*on/i)
    expect(view).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.buyback_wallets/i)
    expect(view).toMatch(/b\.collection_id\s*=\s*s\.collection_id/i)
    // NOT EXISTS keeps a NULL buyer; a `buyer_address NOT IN (…)` would drop it — forbid that shape
    expect(view).not.toMatch(/NOT\s+IN/i)
    expect(src).toMatch(/REVOKE\s+ALL\s+ON\s+public\.sales_market\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i)
    expect(src).toMatch(/GRANT\s+SELECT\s+ON\s+public\.sales_market\s+TO\s+service_role\s*;/i)
  })
})
