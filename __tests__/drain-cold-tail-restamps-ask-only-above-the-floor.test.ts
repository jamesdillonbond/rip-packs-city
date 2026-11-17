// drain_fmv_cold_tail re-stamps a Top Shot ASK_ONLY FMV the moment the ask
// falls below it (2026-10-22, 20261023035607).
//
// An ASK_ONLY price is 0.90 x the ask on the day it was written. Before this,
// nothing re-priced a sale-less edition for 7 days, so a falling ask left the
// FMV ABOVE the cheapest listing for up to a week (75 editions on 10-22,
// e.g. 284:9319 at $405 against a $350 ask). The second candidate arm fixes it.
//
// The arm is only safe with all four properties below; each one is a way it
// could clobber a newer or better price:
//   1. it re-reads the NEWEST fmv_snapshots row (edition_fmv_current lags);
//   2. that row must be ASK_ONLY and above today's ask;
//   3. no 30-day sale (or the loop would write a sales-branch LOW);
//   4. a row whose ask vanished, or which sold, between selection and the loop
//      is skipped (CONTINUE), never demoted to STALE / NO_DATA / LOW.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MIG_DIR = "supabase/migrations"
const BASE = "20261004030511_audit_20261003_run_durations_no_longer_wrap_at_60_seconds.sql"
const CREATE = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.drain_fmv_cold_tail\s*\(/i

function body(file: string): string {
  const src = readFileSync(join(MIG_DIR, file), "utf8")
  const m = CREATE.exec(src)
  if (!m) throw new Error(`${file} does not define drain_fmv_cold_tail`)
  const after = src.slice(m.index)
  const open = after.indexOf("$function$")
  const close = after.indexOf("$function$", open + 1)
  return after.slice(open, close).replace(/--[^\n]*/g, "")
}

function newestFile(): string {
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => CREATE.test(readFileSync(join(MIG_DIR, f), "utf8")))
  return files[files.length - 1]!
}

function askFellArm(b: string): string {
  const start = b.indexOf("ask_fell AS (")
  const end = b.indexOf("SELECT edition_id, tier, last_snapshot, ask_fell", start)
  return start < 0 || end < 0 ? "" : b.slice(start, end)
}

describe("drain_fmv_cold_tail ask-fell arm", () => {
  const newest = body(newestFile())
  const arm = askFellArm(newest)

  it("has the arm, scoped to Top Shot", () => {
    expect(arm.length).toBeGreaterThan(0)
    expect(arm).toMatch(/v_collection_id\s*=\s*'95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid/)
  })

  it("re-reads the newest snapshot and requires it ASK_ONLY and above today's ask", () => {
    expect(arm).toMatch(/JOIN LATERAL \(\s*SELECT[^)]*FROM fmv_snapshots fs[\s\S]*?ORDER BY fs\.computed_at DESC\s+LIMIT 1/)
    expect(arm).toMatch(/cur\.confidence\s*=\s*'ASK_ONLY'/)
    expect(arm).toMatch(/cur\.fmv_usd\s*>\s*b\.low_ask/)
    expect(arm).toMatch(/cur\.computed_at\s*>=\s*NOW\(\)\s*-\s*INTERVAL '7 days'/)
  })

  it("excludes editions with a 30-day sale", () => {
    expect(arm).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM public\.sales_market s[\s\S]*?INTERVAL '30 days'/)
  })

  it("skips, never demotes, an ask-fell row that lost its ask or sold", () => {
    const skips = newest.match(/IF v_edition_row\.ask_fell THEN CONTINUE; END IF;/g) ?? []
    expect(skips.length).toBe(2)
    // the ask-vanished skip sits before the STALE/NO_DATA history read
    const vanished = newest.indexOf("IF v_edition_row.ask_fell THEN CONTINUE; END IF;")
    expect(vanished).toBeLessThan(newest.indexOf("INTO v_hist_median"))
    // the sold skip sits before the sales-branch LOW/SALES_ONLY write
    const sold = newest.lastIndexOf("IF v_edition_row.ask_fell THEN CONTINUE; END IF;")
    expect(sold).toBeLessThan(newest.indexOf("v_confidence := 'SALES_ONLY'"))
  })

  it("control: the base body had no such arm, so the assertions above can fail", () => {
    const base = body(BASE)
    expect(askFellArm(base)).toBe("")
    expect(base).not.toMatch(/v_edition_row\.ask_fell/)
  })
})
