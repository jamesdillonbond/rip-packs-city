#!/usr/bin/env node
/**
 * Migration parity — does every migration APPLIED TO PRODUCTION recently have a
 * committed file in supabase/migrations/?
 *
 * WHY THIS EXISTS
 * ---------------
 * Migrations reach production two ways: `supabase db push` (file first) and the
 * Supabase MCP `apply_migration` (applied first, file committed afterwards by whoever
 * ran it). The second path is normal and heavily used here — but it means the repo
 * record is a MANUAL follow-up step, and any session that cannot push leaves prod
 * ahead of the repo with nothing to notice.
 *
 * That is not hypothetical. On 2026-08-09 the Cowork daytime pass applied two
 * migrations via MCP and then hit a git-proxy 403 ("repo is not in this session's
 * authorized repository set"), so the files sat uncommitted for ~18h. The 08-08 and
 * 08-09 night passes hit a DIFFERENT blocker (`useradd … /sessions no space left on
 * device`) with the same result. Three consecutive runs, two unrelated causes, one
 * shared consequence: prod state the repo cannot describe, and therefore revert paths
 * that exist only in someone's session transcript.
 *
 * This check turns that silent drift into a daily, named failure.
 *
 * WHY IT MATCHES ON **NAME**, NOT VERSION
 * ---------------------------------------
 * `apply_migration` assigns its OWN version stamp at apply time, which will not equal
 * the timestamp in the filename the author later commits. Real example from the run
 * that motivated this script: prod recorded version `20260809155541` for
 * `audit_20260809_allday_pack_detail_ev_lean_view`, while the committed file is
 * `20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql`. Matching on
 * version would flag that as missing forever. The NAME is the stable identity.
 *
 * WHY THE WINDOW IS BOUNDED
 * -------------------------
 * Production carries ~2,478 migration rows against ~402 committed versioned files.
 * The bulk of that gap is historical MCP-applied work from before the repo kept files,
 * and it is NOT actionable — a check that reports ~2,000 findings is noise nobody
 * reads. So this only looks at a recent window (default 14 days), where "there is no
 * file for this" genuinely means "someone's commit is missing".
 *
 * EXIT CODES: 0 clean · 1 drift found · 2 config/query error.
 */

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const WINDOW_DAYS = Number(process.env.MIGRATION_PARITY_WINDOW_DAYS || 14)

/**
 * Names applied to prod that will never have a committed file, with the reason.
 * Keep this SMALL and justified — an entry here is a permanent blind spot.
 */
const KNOWN_FILELESS = new Set([
  // (empty — add only with a reason, e.g. a one-off data fix deliberately not kept)
])

/** `20260809170000_audit_foo.sql` -> `audit_foo`. Returns null for unversioned legacy files. */
function nameFromFile(file) {
  const m = /^(\d{14})_(.+)\.sql$/.exec(file)
  return m ? m[2] : null
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exitCode = 2
    return
  }

  const dir = resolve(process.cwd(), 'supabase/migrations')
  const repoNames = new Set()
  let unversioned = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue
    const n = nameFromFile(f)
    if (n) repoNames.add(n)
    else unversioned++
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // query_sql() is the service_role-only reader (execute_sql returns void).
  // schema_migrations lives in the supabase_migrations schema, which PostgREST
  // does not expose, so it must be reached through query_sql.
  const { data, error } = await supabase.rpc('query_sql', {
    query: `SELECT version, name
              FROM supabase_migrations.schema_migrations
             WHERE version >= to_char(now() - interval '${WINDOW_DAYS} days', 'YYYYMMDD') || '000000'
             ORDER BY version`,
  })
  if (error) {
    console.error('query_sql failed:', error.message)
    process.exitCode = 2
    return
  }

  const applied = data ?? []
  const missing = applied.filter(
    (r) => r.name && !repoNames.has(r.name) && !KNOWN_FILELESS.has(r.name)
  )

  console.log(
    `Migration parity — last ${WINDOW_DAYS}d: ${applied.length} applied to prod, ` +
      `${repoNames.size} versioned files in repo (+${unversioned} unversioned legacy, ignored).`
  )

  if (missing.length === 0) {
    console.log('✓ Every migration applied to production in the window has a committed file.')
    return
  }

  console.error(`\n✗ ${missing.length} migration(s) applied to PRODUCTION with no committed file:\n`)
  for (const r of missing) {
    console.error(`  ${r.version}  ${r.name}`)
  }
  console.error(
    `\nProd is ahead of the repo. Each of these changed production with no committed\n` +
      `revert path. Recover the SQL (the ledger entry, or pg_get_functiondef /\n` +
      `pg_get_viewdef for the objects it touched), commit it as\n` +
      `supabase/migrations/<version>_<name>.sql, and add a ledger entry if missing.\n` +
      `Re-running the committed file against prod should be a no-op.\n` +
      `\nNOTE: matched on NAME, not version — apply_migration stamps its own version, so\n` +
      `the committed filename's timestamp legitimately differs from the prod version.`
  )
  process.exitCode = 1
}

// NOTE: this script sets process.exitCode and RETURNS rather than calling process.exit().
// On Windows, process.exit() while stdout is still flushing a long report trips a libuv
// assertion ("!(handle->flags & UV_HANDLE_CLOSING)") and the shell observes 127 instead
// of the intended code — which would make this check unreadable to CI. Observed
// 2026-08-09 on the first run, when the report listed 114 rows.
main().catch((e) => {
  console.error('check-migration-parity failed:', e?.message || e)
  process.exitCode = 2
})
