// Every HOLDINGS reader of public.topshot_ownership counts only `walk_missed_at IS NULL`
// (docs/reference/topshot-ownership-index.md; wallet-and-portfolio.md Next 5, 2026-10-18).
//
// `walk_missed_at` (20261015200136) flags a row that a clean on-chain walk of its owner did NOT find
// (traded away, burned, moved). The row is kept, never deleted, so a reader that forgets the predicate
// counts a Moment the wallet no longer holds — 18,306 of 532,092 rows (3.4 %) were flagged on 10-18.
// On 10-18 every holdings reader filtered it; this guard keeps a NEW or re-created one from forgetting.
//
// POPULATION (a tree walk, not a list): the NEWEST definition of every function, view and materialized
// view in supabase/migrations — skipping any dropped after it — whose comment-stripped body names
// topshot_ownership; plus every TS file under app/ lib/ components/ scripts/ supabase/functions/ that
// calls `.from("topshot_ownership")`. SUPPRESSION is the curated list: each entry is a claim that the
// object is NOT a holdings reader (a writer, the walker, scheduling, or an nft→edition map, for which
// a flagged row is still true), with the reason.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

const MIG_DIR = "supabase/migrations"
const TABLE = /\btopshot_ownership\b(?!_)/i
const PREDICATE = /\bwalk_missed_at\b/i

// object -> why it may read topshot_ownership without the predicate
const SUPPRESSED_DB: Record<string, string> = {
  mark_topshot_ownership_walk_missed: "the writer that SETS the flag",
  topshot_ownership_walk_missed_clear: "the trigger that CLEARS the flag",
  topshot_index_walk_holdings: "writer: upserts walked holdings (un-flags them)",
  reattribute_topshot_ownership_from_sales: "writer: moves a row to a later buyer",
  get_stale_ownership_wallets: "walk scheduling: a flagged owner must still be re-walked",
  seed_topshot_ownership_walk_candidates: "walk seeding: 'already indexed' includes flagged rows",
  get_ownership_backfill_targets: "backfill planning: which sets the index has EVER seen (maintenance, dead Dune lane)",
  refresh_topshot_moment_id_editions: "nft→edition map: a flagged row's edition is still true",
  collect_wallet_pack_pulls: "nft→edition naming lateral: a flagged row's edition is still true",
  get_topshot_rookie_index_coverage:
    "index COVERAGE note ('the index has walked this edition'), not a holdings count — a flagged row still proves the walk saw the edition",
}

// file -> why its .from("topshot_ownership") reads need no predicate
const SUPPRESSED_TS: Record<string, string> = {
  "app/api/cron/ownership-onchain-walk/route.ts": "the walker: it pages a wallet's rows, flagged ones included, to re-confirm or flag them",
  "app/api/cron/sync-topshot-ownership-dune/route.ts": "the Dune writer: upserts, and sizes paid walks by `source='dune'` row count",
}

type Def = { file: string; kind: string; body: string; dropped: boolean }

const CREATE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
const DROP = /\bDROP\s+(?:FUNCTION|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi

/** Newest definition per object name; a body runs to the next CREATE of an object (or EOF). */
function newestDefinitions(files: Array<{ name: string; src: string }>): Map<string, Def> {
  const defs = new Map<string, Def>()
  for (const { name, src } of files) {
    const code = stripSqlComments(src)
    const events: Array<{ at: number; kind: "create" | "drop"; obj: string; type: string; end?: number }> = []
    const creates = [...code.matchAll(CREATE)]
    creates.forEach((m, i) => {
      const end = i + 1 < creates.length ? (creates[i + 1].index ?? code.length) : code.length
      events.push({ at: m.index ?? 0, kind: "create", obj: m[2].toLowerCase(), type: m[1].toUpperCase(), end })
    })
    for (const m of code.matchAll(DROP)) events.push({ at: m.index ?? 0, kind: "drop", obj: m[1].toLowerCase(), type: "" })
    events.sort((a, b) => a.at - b.at)
    for (const e of events) {
      if (e.kind === "drop") {
        const d = defs.get(e.obj)
        if (d) d.dropped = true
      } else {
        defs.set(e.obj, { file: name, kind: e.type, body: code.slice(e.at, e.end), dropped: false })
      }
    }
  }
  return defs
}

/** Holdings-reader offenders: live objects (not the table itself) naming the table without the predicate. */
function offenders(defs: Map<string, Def>, suppressed: Record<string, string>): string[] {
  const out: string[] = []
  for (const [obj, d] of defs) {
    if (d.dropped || obj === "topshot_ownership" || obj in suppressed) continue
    if (TABLE.test(d.body) && !PREDICATE.test(d.body)) out.push(obj)
  }
  return out.sort()
}

function migrationFiles() {
  return readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => ({ name: f, src: readFileSync(join(MIG_DIR, f), "utf8") }))
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    // POSIX separators: SUPPRESSED_TS is keyed "app/api/…", and on Windows
    // join() returns "app\api\…" — every suppression read as stale there (10-18).
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(p.split("\\").join("/"))
  }
  return out
}

const FROM_TABLE = /\.from\(\s*["'`]topshot_ownership["'`]\s*\)/

describe("topshot_ownership holdings readers count only walk-confirmed rows", () => {
  const defs = newestDefinitions(migrationFiles())

  it("inspects a real population", () => {
    expect(defs.size).toBeGreaterThan(400)
    const readers = [...defs].filter(([o, d]) => !d.dropped && o !== "topshot_ownership" && TABLE.test(d.body))
    expect(readers.length).toBeGreaterThanOrEqual(12)
    // the filtered holdings readers of 2026-10-15 are in the population and carry the predicate
    for (const o of ["get_edition_top_owners", "refresh_topshot_edition_concentration_v2",
                     "topshot_rookie_collector_leaderboard_mv", "topshot_set_completers_mv"]) {
      expect(defs.get(o), o).toBeDefined()
      expect(TABLE.test(defs.get(o)!.body), o).toBe(true)
      expect(PREDICATE.test(defs.get(o)!.body), o).toBe(true)
    }
  })

  it("no un-suppressed function or view reads topshot_ownership without walk_missed_at", () => {
    expect(offenders(defs, SUPPRESSED_DB)).toEqual([])
  })

  it("every DB suppression names a live object that still reads the table without the predicate", () => {
    for (const o of Object.keys(SUPPRESSED_DB)) {
      const d = defs.get(o)
      expect(d, o).toBeDefined()
      expect(d!.dropped, o).toBe(false)
      expect(TABLE.test(d!.body), o).toBe(true)
    }
  })

  it("a dropped object is not a reader (refresh_topshot_edition_concentration v1 was dropped 2026-10-15)", () => {
    expect(defs.get("refresh_topshot_edition_concentration")?.dropped).toBe(true)
  })

  it("a planted holdings reader without the predicate is caught, and adding the predicate clears it", () => {
    const planted = newestDefinitions([
      ...migrationFiles(),
      { name: "99999999999999_planted.sql", src:
        "-- planted\nCREATE OR REPLACE FUNCTION public.zz_planted_holdings(p text) RETURNS bigint LANGUAGE sql AS $$\n" +
        "  SELECT count(*) FROM public.topshot_ownership o WHERE o.owner_address = p\n$$;\n" },
    ])
    expect(offenders(planted, SUPPRESSED_DB)).toEqual(["zz_planted_holdings"])
    const fixed = newestDefinitions([
      ...migrationFiles(),
      { name: "99999999999999_planted.sql", src:
        "CREATE OR REPLACE FUNCTION public.zz_planted_holdings(p text) RETURNS bigint LANGUAGE sql AS $$\n" +
        "  SELECT count(*) FROM public.topshot_ownership o WHERE o.owner_address = p AND o.walk_missed_at IS NULL\n$$;\n" },
    ])
    expect(offenders(fixed, SUPPRESSED_DB)).toEqual([])
    // a predicate that exists only in a COMMENT does not count
    const commented = newestDefinitions([
      { name: "1_x.sql", src:
        "CREATE VIEW public.zz_v AS SELECT * FROM public.topshot_ownership -- walk_missed_at IS NULL\n;\n" },
    ])
    expect(offenders(commented, {})).toEqual(["zz_v"])
  })

  it("TS: every .from(\"topshot_ownership\") file filters walk_missed_at or is a suppressed maintenance path", () => {
    const files = ["app", "lib", "components", "scripts", "supabase/functions"].flatMap((r) => walk(r))
    expect(files.length).toBeGreaterThan(500)
    const readers = files.filter((f) => FROM_TABLE.test(stripComments(readFileSync(f, "utf8"))))
    for (const f of Object.keys(SUPPRESSED_TS)) expect(readers, `stale TS suppression: ${f}`).toContain(f)
    const bad = readers.filter((f) => !(f in SUPPRESSED_TS) && !PREDICATE.test(stripComments(readFileSync(f, "utf8"))))
    expect(bad).toEqual([])
  })
})
