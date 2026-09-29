import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// get_lock_check_batch's USER tier must be saved wallets and their Hybrid
// Custody counterparts — never every linked_accounts address.
//
// 2026-09-29: linked_accounts went 217 -> 1,319 rows (the child-side backfill),
// and because `hot` UNIONed both sides of EVERY link into the user tier, the next
// Top Shot batch gave 1,000 / 1,000 rows to one trader wallet and 0 to saved
// wallets. linked_accounts records chain accounts, not RPC users.

const MIG = join(process.cwd(), "supabase/migrations")

function newestDefinition(fn: string): { file: string; sql: string } {
  const files = readdirSync(MIG).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIG, files[i]), "utf8")
    // FUNCTION or PROCEDURE: a redefinition as either is the newest definition.
    if (new RegExp(`CREATE OR REPLACE (FUNCTION|PROCEDURE) public\\.${fn}\\(`).test(sql)) return { file: files[i], sql }
  }
  throw new Error(`no migration defines ${fn}`)
}

// The `hot` CTE text, from `hot AS (` to the `cand AS (` that follows it.
function hotCte(sql: string): string {
  const body = sql.slice(sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.get_lock_check_batch("))
  const a = body.indexOf("hot AS (")
  const b = body.indexOf("cand AS (", a)
  if (a < 0 || b < 0) throw new Error("hot CTE not found")
  return body.slice(a, b).replace(/--[^\n]*/g, "")
}

// Every linked_accounts reference in the user tier must be joined to `saved`.
function linkedSidesAreSavedScoped(hot: string): boolean {
  const refs = [...hot.matchAll(/FROM\s+(public\.)?linked_accounts\b[^\n]*/g)].map((m) => m[0])
  return refs.length > 0 && refs.every((r) => /\bJOIN\s+saved\s+ON\b/.test(r))
}

describe("get_lock_check_batch: the user tier is saved wallets, not every link", () => {
  const { file, sql } = newestDefinition("get_lock_check_batch")
  const hot = hotCte(sql)

  it(`the newest definition (${file}) scopes every linked_accounts side to a saved wallet`, () => {
    expect(linkedSidesAreSavedScoped(hot)).toBe(true)
  })

  it("saved_wallets is still in the user tier (the tier did not go empty)", () => {
    expect(sql).toMatch(/saved AS \(\s*SELECT saved_wallets\.wallet_addr AS addr FROM saved_wallets/)
    expect(hot).toMatch(/SELECT saved\.addr, true FROM saved/)
  })

  it("only ACTIVE links count", () => {
    const refs = [...hot.matchAll(/FROM\s+linked_accounts\b[^\n]*/g)].map((m) => m[0])
    expect(refs.every((r) => /WHERE l\.active\b/.test(r))).toBe(true)
  })

  it("control: the check FAILS on the 2026-09-02 body that shipped the defect", () => {
    const old = readFileSync(
      join(MIG, "20260902035016_audit_20260902_lock_check_batch_prioritises_user_wallets_over_seeded_coverage.sql"),
      "utf8",
    )
    expect(linkedSidesAreSavedScoped(hotCte(old))).toBe(false)
  })
})
