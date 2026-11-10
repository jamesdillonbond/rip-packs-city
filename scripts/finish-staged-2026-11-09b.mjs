#!/usr/bin/env node
// scripts/finish-staged-2026-11-09b.mjs — the REPO half of docs/handoff-2026-11-09b-cowork-apply-rotated-slice.md.
//
// Run ONLY after docs/proposals/rip-metadata-queue-rotated-slice-STAGED.sql has been applied to production
// and its supabase_migrations.schema_migrations row written, passing that version:
//
//   node scripts/finish-staged-2026-11-09b.mjs <version>
//
// It moves the staged migration into supabase/migrations/ under that version, installs the updated
// backfill_pack_rip_metadata pin (both functions verbatim) with its header pointer set, and re-points the
// two PINS entries in __tests__/db-invariants-drift-guard.test.ts. Refuses to run twice or on a bad version;
// writes nothing unless every check passes. Then: drift-guard test, delete this script, commit, push.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const [v] = process.argv.slice(2)
const die = (m) => { console.error(`finish-staged-b: ${m} — nothing changed`); process.exit(1) }
if (!/^\d{14}$/.test(v ?? "")) die("usage: <version> (14 digits)")

const P = (p) => join(ROOT, p)
const STAGED = "docs/proposals/rip-metadata-queue-rotated-slice-STAGED.sql"
const STAGED_PIN = "docs/proposals/rip-metadata-queue-rotated-slice-PIN-STAGED.sql.txt"
const NAME = "audit_20261109_rip_metadata_queue_is_read_as_a_rotated_slice.sql"
const MIG = `supabase/migrations/${v}_${NAME}`
const PIN = "supabase/tests/backfill_pack_rip_metadata.sql"
const GUARD = "__tests__/db-invariants-drift-guard.test.ts"
const OLD = "supabase/migrations/20261110005700_audit_20261109_rip_metadata_eligibility_is_precomputed.sql"

for (const f of [STAGED, STAGED_PIN, PIN, GUARD]) if (!existsSync(P(f))) die(`missing ${f} (already run?)`)
if (existsSync(P(MIG))) die(`${MIG} already exists`)

const pin = readFileSync(P(STAGED_PIN), "utf8")
const PH = `2026111XXXXXXX_${NAME}`
if (pin.split(PH).length !== 2) die("pin header placeholder not found exactly once")
const guard = readFileSync(P(GUARD), "utf8")
const oldRef = `"${OLD}"`
if (guard.split(oldRef).length !== 3) die("expected exactly two drift-guard PINS on the first-step migration")

writeFileSync(P(MIG), readFileSync(P(STAGED), "utf8"))
writeFileSync(P(PIN), pin.replace(PH, `${v}_${NAME}`))
writeFileSync(P(GUARD), guard.split(oldRef).join(`"${MIG}"`))
for (const f of [STAGED, STAGED_PIN]) unlinkSync(P(f))
console.log(`finish-staged-b: wrote ${MIG}; updated ${PIN}, ${GUARD}; removed the two staged files`)
console.log("next: npx vitest run __tests__/db-invariants-drift-guard.test.ts && git rm this script, commit, push")
