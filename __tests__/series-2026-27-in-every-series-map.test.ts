// Every hand-written Top Shot series map that knows Series 2025-26 (on-chain 8) also knows Series 2026-27
// (on-chain 9). Tip-off is 2026-10-20.
//
// WHY (2026-10-18 pre-launch readiness check): the canonical maps (lib/series-label.ts,
// lib/analytics/series-labels.ts, SERIES_RANK, …) already had 9, but copies did not. The sniper feed's
// SERIES_NAMES, the concierge deal search and fmv's map stopped at 8, and so did three DB functions
// (get_team_checklist / _progress `series_season`, analytics_sets_series_overview's label), fixed by
// 20261018162955. A map that stops one series short fails SILENTLY: a blank label, "S9", "Series 9",
// or a Contemporary checklist that drops every new edition.
//
// POPULATION (a tree walk): every .ts/.tsx under app/ lib/ components/ whose comment-stripped source
// contains an `8: "25-26"`-shaped short label or an `8: "Series 2025-26"` long label must carry the 9
// entry of the same shape. The newest definition of every SQL function in supabase/migrations whose
// body contains `WHEN 8 THEN 2025` or `WHEN 8 THEN 'Series 2025-26'` must carry the matching WHEN 9.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

const TS_RULES: Array<{ has: RegExp; needs: RegExp; name: string }> = [
  { name: 'short "25-26"', has: /\b8\s*:\s*["'`]25-26["'`]/, needs: /\b9\s*:\s*["'`]26-27["'`]/ },
  { name: 'long "Series 2025-26"', has: /\b8\s*:\s*["'`]Series 2025-26["'`]/, needs: /\b9\s*:\s*["'`]Series 2026-27["'`]/ },
]

const SQL_RULES: Array<{ has: RegExp; needs: RegExp; name: string }> = [
  { name: "season 2025", has: /WHEN\s+8\s+THEN\s+2025\b/i, needs: /WHEN\s+9\s+THEN\s+2026\b/i },
  { name: "label 'Series 2025-26'", has: /WHEN\s+8\s+THEN\s+'Series 2025-26'/i, needs: /WHEN\s+9\s+THEN\s+'Series 2026-27'/i },
]

function newestFunctionBodies(): Map<string, { file: string; body: string; dropped: boolean }> {
  const dir = "supabase/migrations"
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  const defs = new Map<string, { file: string; body: string; dropped: boolean }>()
  const create = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\(/gi
  const drop = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi
  for (const f of files) {
    const code = stripSqlComments(readFileSync(join(dir, f), "utf8"))
    for (const m of code.matchAll(drop)) {
      const d = defs.get(m[1].toLowerCase())
      if (d) d.dropped = true
    }
    const ms = [...code.matchAll(create)]
    ms.forEach((m, i) => {
      const end = i + 1 < ms.length ? (ms[i + 1].index ?? code.length) : code.length
      defs.set(m[1].toLowerCase(), { file: f, body: code.slice(m.index ?? 0, end), dropped: false })
    })
  }
  return defs
}

describe("Series 2026-27 is in every series map that has Series 2025-26", () => {
  it("TS: no map stops at series 8", () => {
    const files = ["app", "lib", "components"].flatMap((r) => walk(r))
    expect(files.length).toBeGreaterThan(500)
    const withMaps: string[] = []
    const bad: string[] = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"))
      for (const r of TS_RULES) {
        if (r.has.test(code)) {
          withMaps.push(f)
          if (!r.needs.test(code)) bad.push(`${f} (${r.name})`)
        }
      }
    }
    // not vacuous: the copies fixed 2026-10-18 and the canonical label map are in the population
    for (const f of ["app/api/sniper-feed/route.ts", "app/api/support-chat/search-deals/route.ts", "lib/analytics/series-labels.ts"]) {
      expect(withMaps, f).toContain(f)
    }
    expect(bad).toEqual([])
  })

  it("SQL: no live function maps series 8 without series 9", () => {
    const defs = newestFunctionBodies()
    expect(defs.size).toBeGreaterThan(400)
    const withMaps: string[] = []
    const bad: string[] = []
    for (const [fn, d] of defs) {
      if (d.dropped) continue
      for (const r of SQL_RULES) {
        if (r.has.test(d.body)) {
          withMaps.push(fn)
          if (!r.needs.test(d.body)) bad.push(`${fn} in ${d.file} (${r.name})`)
        }
      }
    }
    for (const fn of ["get_team_checklist", "get_team_checklist_progress", "analytics_sets_series_overview"]) {
      expect(withMaps, fn).toContain(fn)
    }
    expect(bad).toEqual([])
  })

  it("the rules catch a planted map that stops at 8", () => {
    const planted = 'const M = { 7: "24-25", 8: "25-26" }'
    expect(TS_RULES[0].has.test(planted) && !TS_RULES[0].needs.test(planted)).toBe(true)
    const sql = "CASE e.series WHEN 7 THEN 2024 WHEN 8 THEN 2025 ELSE NULL END"
    expect(SQL_RULES[0].has.test(sql) && !SQL_RULES[0].needs.test(sql)).toBe(true)
  })
})
