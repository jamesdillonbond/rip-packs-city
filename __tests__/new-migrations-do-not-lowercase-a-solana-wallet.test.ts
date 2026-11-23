// __tests__/new-migrations-do-not-lowercase-a-solana-wallet.test.ts
//
// BAN AT ZERO, FORWARD ONLY: a migration after 20261123051216 may not match a wallet
// parameter through a bare `lower(p_wallet…)`.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────────
// A Flow/EVM address is hex and case-insensitive; a Solana (Candy) address is
// base58 and CASE-SENSITIVE (CLAUDE.md, "Chain two"). `where wallet_address =
// lower(p_wallet)` therefore matches nothing for a Candy wallet, and the surface
// publishes "holds nothing" — no error anywhere. Found 2026-11-22 in
// `get_collection_breakdown` and `export_wallet_csv`: the one saved Candy wallet's
// 575 moments were absent from its owner's profile and CSV export
// (fixed by 20261123051216). A sweep found 26 public functions lowercasing a
// wallet parameter; the others are Flow-only by construction, which is why the
// existing ones are not rewritten and this guard is forward-only.
//
// ── THE RULE ───────────────────────────────────────────────────────────────────
// Lowercase only a hex address — the repo's SQL idiom:
//     CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END
// A function that can only ever see a Flow address (a Top Shot-only set read, a
// route that rejects anything but `0x` + 16 hex) may say so inline within 8 lines
// above the match:
//     -- solana-lower: flow-only (<why>)
//
// Satisfiable at a population of zero; it states the count it inspected, and its
// detector is proved by the planted cases below.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripSqlComments } from "../scripts/lib/strip-sql-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

const MIGRATIONS = join(process.cwd(), "supabase", "migrations")
const CUTOFF = "20261123051216" // everything strictly after this file is in scope
const MARKER = /solana-lower:\s*flow-only/i
const LOOKBACK = 8

const LOWER_PARAM = /\blower\(\s*p_(?:wallet|wallet_address|wallet_addr|address|addr)\s*\)/gi
// The hex guard immediately before the match: `… ~* '^0x' THEN lower(p_wallet)`.
const HEX_GUARD_BEFORE = /~\*\s*'\^0x'\s*THEN\s*$/i

/** Offsets of bare `lower(p_wallet…)` calls in comment-stripped SQL. */
export function bareLowerOffsets(sql: string): number[] {
  const out: number[] = []
  for (const m of sql.matchAll(LOWER_PARAM)) {
    const at = m.index ?? 0
    const before = sql.slice(Math.max(0, at - 60), at)
    if (!HEX_GUARD_BEFORE.test(before)) out.push(at)
  }
  return out
}

function migrationsInScope(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const v = /^(\d{14})_/.exec(f)
      return v !== null && v[1] > CUTOFF
    })
    .sort()
}

describe("bareLowerOffsets — the detector", () => {
  it("flags a bare lower(p_wallet)", () => {
    expect(bareLowerOffsets("where w.wallet_address = lower(p_wallet)")).toHaveLength(1)
    expect(bareLowerOffsets("values (lower(p_wallet_address), 1)")).toHaveLength(1)
  })
  it("passes the hex-guarded idiom", () => {
    expect(bareLowerOffsets("where w.wallet_address = CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END")).toEqual([])
  })
  it("the two functions fixed by the cutoff migration pass it", () => {
    const src = readFileSync(join(MIGRATIONS, "20261123051216_audit_20261122_profile_breakdown_and_export_read_solana_wallets.sql"), "utf8")
    expect(bareLowerOffsets(stripSqlComments(src))).toEqual([])
  })
  it("the bodies they replaced fail it (planted defect: the previous body)", () => {
    const src = readFileSync(join(MIGRATIONS, "20261110175500_audit_20261110_withdrawn_prices_in_wallets_count_as_stale.sql"), "utf8")
    expect(bareLowerOffsets(stripSqlComments(src)).length).toBeGreaterThan(0)
  })
})

describe("a migration after 20261123051216 may not lowercase a wallet parameter without a hex guard", () => {
  const files = migrationsInScope()

  it("the scan ran", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))
    expect(all.length).toBeGreaterThan(1000)
    console.log(`[solana-lower guard] ${all.length} migration file(s) on disk, ${files.length} after ${CUTOFF} in scope`)
  })

  it("no in-scope migration matches a wallet through a bare lower()", () => {
    const violations: string[] = []
    for (const file of files) {
      const raw = readFileSync(join(MIGRATIONS, file), "utf8")
      const rawLines = raw.split("\n")
      // Offsets are taken on the RAW text so a line number can be reported and the marker read;
      // a match inside a comment is dropped by re-checking the stripped text.
      const strippedHits = bareLowerOffsets(stripSqlComments(raw)).length
      if (strippedHits === 0) continue
      for (const at of bareLowerOffsets(raw)) {
        const line = raw.slice(0, at).split("\n").length - 1
        if (/^\s*--/.test(rawLines[line] ?? "")) continue
        if (isMarkerSuppressed(rawLines, line, MARKER, LOOKBACK)) continue
        violations.push(`${file}:${line + 1}: ${(rawLines[line] ?? "").trim()}`)
      }
    }
    expect(
      violations,
      `A base58 Solana address is case-sensitive: lower() makes a Candy wallet match nothing.\n` +
        `Use CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END, or mark a Flow-only function\n` +
        `with "-- solana-lower: flow-only (<why>)" within ${LOOKBACK} lines above.\n` +
        violations.join("\n"),
    ).toEqual([])
  })
})
