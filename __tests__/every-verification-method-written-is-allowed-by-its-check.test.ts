import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// R: A VALUE A FUNCTION WRITES MUST BE ONE ITS COLUMN'S CHECK ALLOWS.
//
// 2026-09-14: resolve_wallet_signature_match shipped writing
// `verification_method = 'wallet_signature'` while
// saved_wallets_verification_method_check allowed only
// NULL|fcl_dapper|fcl_blocto|fcl_other|listing_challenge|owner_attested. The
// first real verification would have raised 23514 and surfaced as a 500.
//
// ⚠ NOTHING IN THE SUITE COULD HAVE SEEN IT. The unit tests never touch the DB;
// the function's own early guard returns before the UPDATE, so a positive
// control that stops there reads clean. The defect lives in the gap BETWEEN two
// SQL files, which is exactly where a source scan can look.
//
// This is a ban at zero over the migrations tree, not an allowlist: it reads the
// CHECK from whichever migration defines it LAST (migrations apply in filename
// order, so the last definition is the live one) and requires every literal any
// migration assigns to that column to be inside it.

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations")

function migrationsInApplyOrder(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }))
}

/**
 * Strip `--` line comments so a value discussed in a REVERT block or a header
 * note is not mistaken for one the migration writes. Block comments are not
 * used in this tree's SQL; string literals cannot contain `--` in these files.
 */
const stripSqlComments = (sql: string) => sql.replace(/^[ \t]*--.*$/gm, "")

/** The last CHECK definition for verification_method, in apply order. */
function liveAllowedValues(): { values: Set<string>; definedIn: string } | null {
  let found: { values: Set<string>; definedIn: string } | null = null
  for (const { name, sql } of migrationsInApplyOrder()) {
    const body = stripSqlComments(sql)
    // Match the ARRAY[...] of the CHECK that constrains verification_method.
    const re = /verification_method\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(body))) {
      const values = new Set(
        Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
      )
      if (values.size > 0) found = { values, definedIn: name }
    }
  }
  return found
}

/** Every literal any migration ASSIGNS to verification_method. */
function writtenValues(): Array<{ value: string; file: string }> {
  const out: Array<{ value: string; file: string }> = []
  for (const { name, sql } of migrationsInApplyOrder()) {
    const body = stripSqlComments(sql)
    for (const m of body.matchAll(/verification_method\s*=\s*'([^']+)'/gi)) {
      // An assignment inside SET, not a comparison inside a CHECK/WHERE. The
      // CHECK form is `verification_method = ANY (ARRAY[...])`, already excluded
      // by requiring a quoted literal here.
      out.push({ value: m[1], file: name })
    }
  }
  return out
}

describe("every verification_method a migration writes is allowed by its CHECK", () => {
  const allowed = liveAllowedValues()
  const written = writtenValues()

  it("found the live CHECK (guards against the scan silently matching nothing)", () => {
    expect(allowed, "no verification_method CHECK found in supabase/migrations").not.toBeNull()
    expect(allowed!.values.size).toBeGreaterThan(1)
  })

  it("found at least one writer (the same positive control, other direction)", () => {
    // If this ever reaches zero the assertion below becomes vacuous and would
    // pass while the invariant is unguarded.
    expect(written.length).toBeGreaterThan(0)
  })

  it("writes no value the CHECK would reject", () => {
    const offenders = written
      .filter((w) => !allowed!.values.has(w.value))
      .map((w) => `${w.file} writes '${w.value}' (allowed: ${[...allowed!.values].sort().join(", ")})`)
    expect(offenders).toEqual([])
  })

  it("still allows the value the signature path writes", () => {
    // Named because this is the instance the rule was written for: pin the
    // property, not the spelling of the error.
    expect(allowed!.values.has("wallet_signature")).toBe(true)
  })
})
