#!/usr/bin/env node
// scripts/finish-staged-2026-11-09.mjs — the REPO half of docs/handoff-2026-11-09-cowork-apply-staged-sql.md.
//
// Run it ONLY after both staged SQL files have been applied to production and their
// supabase_migrations.schema_migrations rows written, passing the two versions you wrote:
//
//   node scripts/finish-staged-2026-11-09.mjs <version_242> <version_selfheal>
//
// It moves each staged file into supabase/migrations/ under its applied version (migration-parity
// keys on the version), installs the updated backfill_pack_rip_metadata pin with its header pointer
// set, and re-points / adds the two PINS entries in __tests__/db-invariants-drift-guard.test.ts.
// It refuses to run twice, refuses a malformed version, and changes nothing if any check fails.
// Then: `npx vitest run __tests__/db-invariants-drift-guard.test.ts`, commit, push.
//
// Delete this script in the same commit (it is a one-off).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const [v242, vSelf] = process.argv.slice(2)
const die = (m) => { console.error(`finish-staged: ${m} — nothing changed`); process.exit(1) }

if (!/^\d{14}$/.test(v242 ?? "") || !/^\d{14}$/.test(vSelf ?? "")) die("usage: <version_242> <version_selfheal> (14 digits each)")
if (v242 === vSelf) die("the two versions must differ")

const P = (p) => join(ROOT, p)
const STAGED_242 = "docs/proposals/rip-metadata-eligibility-precomputed-STAGED.sql"
const STAGED_PIN = "docs/proposals/rip-metadata-eligibility-precomputed-PIN-STAGED.sql.txt"
const STAGED_SELF = "docs/proposals/wmc-selfheal-skips-candy-STAGED.sql"
const MIG_242 = `supabase/migrations/${v242}_audit_20261109_rip_metadata_eligibility_is_precomputed.sql`
const MIG_SELF = `supabase/migrations/${vSelf}_audit_20261109_wmc_selfheal_skips_candy_and_writes_only_what_it_can_fill.sql`
const PIN = "supabase/tests/backfill_pack_rip_metadata.sql"
const GUARD = "__tests__/db-invariants-drift-guard.test.ts"
const OLD_MIG = "supabase/migrations/20261102201245_audit_20261102_8911_rekey_and_unique_pool_vote.sql"

for (const f of [STAGED_242, STAGED_PIN, STAGED_SELF, PIN, GUARD]) if (!existsSync(P(f))) die(`missing ${f} (already run?)`)
for (const f of [MIG_242, MIG_SELF]) if (existsSync(P(f))) die(`${f} already exists`)

// --- compute every new file content first; write only if all checks pass ---
const pin = readFileSync(P(STAGED_PIN), "utf8")
const PLACEHOLDER = "20261110XXXXXX_audit_20261109_rip_metadata_eligibility_is_precomputed.sql"
if (pin.split(PLACEHOLDER).length !== 2) die("pin header placeholder not found exactly once")
const newPin = pin.replace(PLACEHOLDER, `${v242}_audit_20261109_rip_metadata_eligibility_is_precomputed.sql`)

const guard = readFileSync(P(GUARD), "utf8")
const anchor = `    fn: "backfill_pack_rip_metadata",
    test: "supabase/tests/backfill_pack_rip_metadata.sql",
    migration:
      "${OLD_MIG}",
  },`
if (guard.split(anchor).length !== 2) die("drift-guard backfill_pack_rip_metadata entry not found exactly once")
const replacement = `    fn: "backfill_pack_rip_metadata",
    test: "supabase/tests/backfill_pack_rip_metadata.sql",
    // Re-pinned 2026-11-09 (#242): the two whole-set eligibility legs read a precomputed queue.
    migration:
      "${MIG_242}",
  },
  {
    // Added 2026-11-09 (#242): builds the queue backfill_pack_rip_metadata re-checks; pg_cron every 2 h.
    fn: "refresh_pack_rip_backfill_eligible",
    test: "supabase/tests/backfill_pack_rip_metadata.sql",
    migration:
      "${MIG_242}",
  },`
const newGuard = guard.replace(anchor, replacement)

// --- write ---
writeFileSync(P(MIG_242), readFileSync(P(STAGED_242), "utf8"))
writeFileSync(P(MIG_SELF), readFileSync(P(STAGED_SELF), "utf8"))
writeFileSync(P(PIN), newPin)
writeFileSync(P(GUARD), newGuard)
for (const f of [STAGED_242, STAGED_PIN, STAGED_SELF]) unlinkSync(P(f))
console.log(`finish-staged: wrote ${MIG_242}\n               wrote ${MIG_SELF}\n               updated ${PIN}, ${GUARD}\n               removed the three staged files`)
console.log("next: npx vitest run __tests__/db-invariants-drift-guard.test.ts && delete this script, commit, push")
