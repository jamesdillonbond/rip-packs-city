#!/usr/bin/env node
// scripts/finish-staged-2026-11-09c.mjs — the REPO half of docs/handoff-2026-11-09c-cowork-candy-trophies-and-orphans.md.
//
// Run ONLY after docs/proposals/candy-trophies-mlb-only-and-orphan-cleanup-STAGED.sql is applied to production
// and its supabase_migrations.schema_migrations row written, passing that version:
//
//   node scripts/finish-staged-2026-11-09c.mjs <version>
//
// Moves the staged migration into supabase/migrations/ under that version, installs the new pin
// supabase/tests/candy_delete_orphan_one_of_one_editions.sql with its header pointer set, and registers
// the function in __tests__/db-invariants-drift-guard.test.ts. Refuses to run twice or on a bad version;
// writes nothing unless every check passes. Then: drift-guard test, delete this script, commit, push.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const [v] = process.argv.slice(2)
const die = (m) => { console.error(`finish-staged-c: ${m} — nothing changed`); process.exit(1) }
if (!/^\d{14}$/.test(v ?? "")) die("usage: <version> (14 digits)")

const P = (p) => join(ROOT, p)
const STAGED = "docs/proposals/candy-trophies-mlb-only-and-orphan-cleanup-STAGED.sql"
const STAGED_PIN = "docs/proposals/candy-orphan-one-of-one-PIN-STAGED.sql.txt"
const NAME = "audit_20261109_candy_trophies_mlb_only_and_orphan_one_of_one_cleanup.sql"
const MIG = `supabase/migrations/${v}_${NAME}`
const PIN = "supabase/tests/candy_delete_orphan_one_of_one_editions.sql"
const GUARD = "__tests__/db-invariants-drift-guard.test.ts"

for (const f of [STAGED, STAGED_PIN, GUARD]) if (!existsSync(P(f))) die(`missing ${f} (already run?)`)
for (const f of [MIG, PIN]) if (existsSync(P(f))) die(`${f} already exists`)

const pin = readFileSync(P(STAGED_PIN), "utf8")
const PH = `2026111XXXXXXX_${NAME}`
if (pin.split(PH).length !== 2) die("pin header placeholder not found exactly once")
const guard = readFileSync(P(GUARD), "utf8")
const anchor = `    // Added 2026-11-08 (#221). wmc player names follow the catalog where the cached spelling is a`
if (guard.split(anchor).length !== 2) die("drift-guard anchor (the #221 heal_wmc_player_names_from_catalog comment) not found exactly once")
if (guard.includes(`fn: "candy_delete_orphan_one_of_one_editions"`)) die("drift guard already registers the function")
const entry = `    // Added 2026-11-09: deletes Candy 1/1 editions no card holds (after the 1-of-1 re-key); hourly pg_cron.
    fn: "candy_delete_orphan_one_of_one_editions",
    test: "${PIN}",
    migration: "${MIG}",
  },
  {
${anchor}`

writeFileSync(P(MIG), readFileSync(P(STAGED), "utf8"))
writeFileSync(P(PIN), pin.replace(PH, `${v}_${NAME}`))
writeFileSync(P(GUARD), guard.replace(anchor, entry))
for (const f of [STAGED, STAGED_PIN]) unlinkSync(P(f))
console.log(`finish-staged-c: wrote ${MIG} and ${PIN}; registered the pin in ${GUARD}; removed the two staged files`)
console.log("next: npx vitest run __tests__/db-invariants-drift-guard.test.ts && git rm this script, commit, push")
