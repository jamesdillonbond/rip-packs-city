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
 * WHY IT READS **GIT**, NOT JUST THE DIRECTORY
 * --------------------------------------------
 * Until 2026-08-10 this walked `readdirSync(supabase/migrations)` — so a file that
 * existed on disk but had never been `git add`ed satisfied the check. That is not a
 * corner case: it is EXACTLY the state this job was built to catch. A session that
 * applies a migration via MCP and then cannot push leaves the file sitting untracked
 * in the working tree, and the check read that as parity.
 *
 * Observed 2026-08-10: `20260811033305` / `20260811033331` (candy pack-EV) sat
 * untracked, with their ledger entry already committed, while the 3-day window
 * reported 0. The job was blind to its own headline scenario.
 *
 * So the repo side is now the COMMITTED tree (`git ls-tree HEAD`), and a file that is
 * present on disk but absent from that tree is reported as `[UNTRACKED]` — a distinct,
 * sharper finding than `[MISSING]`, because the fix is one `git add` rather than a
 * recovery. If git is unavailable the check falls back to the directory scan and says
 * so LOUDLY; it never silently degrades to the weaker test.
 *
 * WHY THE WINDOW IS BOUNDED
 * -------------------------
 * Production carries far more migration rows than the repo has committed versioned
 * files (2,570 vs 596 measured 2026-08-20; it was 2,478 vs ~402 on 2026-08-10 — both
 * are DATED SAMPLES, re-derive before quoting either). The bulk of that gap is
 * historical MCP-applied work from before the repo kept files, and it is NOT
 * actionable — a check that reports ~2,000 findings is noise nobody reads. So this
 * only looks at a recent window (default 14 days), where "there is no file for this"
 * genuinely means "someone's commit is missing".
 *
 * ⚠ THE RECENT WINDOW IS NOW CLEAN, AND THAT IS WHAT MADE THE JOB ENFORCING.
 * Re-derived 2026-08-20 against the live table: drift at 3d / 7d / 14d was 3 / 5 / 5,
 * all five being one afternoon's rpc_search_catalog v2/v3/v4 prototypes plus their
 * own drops. They were recovered byte-exactly from prod (md5 compared against
 * `md5(array_to_string(statements, E'\n'))`, all five matching) and committed, taking
 * every window to 0 — so .github/workflows/migration-parity.yml dropped its `|| true`
 * the same day. See __tests__/migration-parity-workflow-is-enforcing.test.ts, which
 * pins that posture so it cannot quietly revert to warning-only.
 *
 * EXIT CODES: 0 clean · 1 drift found · 2 config/query error.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

/**
 * Is this query error the TRANSIENT PostgREST schema-cache class (PGRST002)?
 *
 * Exported so the guard can test the real decision rather than grep this file's
 * text. ⚠ The distinction is load-bearing in BOTH directions: retrying a genuine
 * config/permission error burns ~50s pretending it might recover, and NOT
 * retrying the schema-cache burst is what made this detector red on 3 of its
 * last 4 scheduled runs — every one a false red.
 */
export function isTransientQueryError(message) {
  return /schema cache|PGRST002|Could not query the database/i.test(message ?? '')
}

const MIGRATIONS_DIR = 'supabase/migrations'

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

/**
 * Migration names that are COMMITTED (present in the HEAD tree), or null when git
 * cannot answer. Null is the caller's signal to fall back and warn — never to pass.
 */
function committedNames() {
  try {
    const out = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', 'HEAD', '--', MIGRATIONS_DIR],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const names = new Set()
    for (const path of out.split('\n')) {
      if (!path.endsWith('.sql')) continue
      const n = nameFromFile(basename(path))
      if (n) names.add(n)
    }
    return names
  } catch {
    return null // not a git repo, no HEAD yet, or git missing
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exitCode = 2
    return
  }

  const dir = resolve(process.cwd(), MIGRATIONS_DIR)
  const diskNames = new Set()
  let unversioned = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue
    const n = nameFromFile(f)
    if (n) diskNames.add(n)
    else unversioned++
  }

  // The repo side is the COMMITTED tree. A file on disk that was never `git add`ed is
  // the exact state a push outage leaves behind, and must not read as parity.
  const tracked = committedNames()
  const gitBlind = tracked === null
  const repoNames = gitBlind ? diskNames : tracked
  if (gitBlind) {
    console.error(
      '⚠ git could not be read (not a repo, no HEAD, or git missing) — falling back to a\n' +
        '  DIRECTORY scan. An uncommitted file will read as parity in this mode. Fix the\n' +
        '  checkout rather than trusting a green result.'
    )
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // query_sql() is the service_role-only reader (execute_sql returns void).
  // schema_migrations lives in the supabase_migrations schema, which PostgREST
  // does not expose, so it must be reached through query_sql.
  const PARITY_QUERY = `SELECT version, name
              FROM supabase_migrations.schema_migrations
             WHERE version >= to_char(now() - interval '${WINDOW_DAYS} days', 'YYYYMMDD') || '000000'
             ORDER BY version`

  // ⚠ PGRST002 IS THE EXPECTED CASE HERE, NOT AN EXCEPTIONAL ONE, AND IT WAS
  // MAKING THIS DETECTOR LIE. Every `apply_migration` triggers a ~10-20s
  // PostgREST schema-cache re-introspection burst; this check runs on a
  // schedule, so collisions are routine rather than rare. Measured 2026-08-30:
  // 3 of the last 4 SCHEDULED runs died on
  //   "Could not query the database for the schema cache. Retrying."
  // and exited 2 — every one a FALSE RED, on a detector the sentinel reports as
  // NOT CONFIGURED (no GITHUB_ACTIONS_READ_TOKEN), i.e. nobody was reading it.
  // A detector that is red most days cannot be distinguished from a broken one
  // at a glance, so a REAL parity violation would have looked identical.
  //
  // ⚠ The word "Retrying." in that log line belongs to POSTGREST'S OWN ERROR
  // MESSAGE — this script had no retry at all. It reads as though it did, which
  // is exactly why nobody added one.
  //
  // Retry ONLY the transient class: a genuine config/permission error must
  // still fail fast rather than burn 50s pretending it might recover. And a
  // check that CANNOT RUN must never read as a pass — exitCode stays 2.
  const BACKOFF_MS = [5000, 15000, 30000] // ~50s total, comfortably past the burst

  let data, error
  let attempts = 0
  for (let i = 0; ; i++) {
    attempts++
    ;({ data, error } = await supabase.rpc('query_sql', { query: PARITY_QUERY }))
    if (!error) break
    if (!isTransientQueryError(error.message) || i >= BACKOFF_MS.length) break
    console.error(
      `query_sql transient error (attempt ${attempts}/${BACKOFF_MS.length + 1}): ` +
        `${error.message} — retrying in ${BACKOFF_MS[i]}ms`,
    )
    await new Promise((r) => setTimeout(r, BACKOFF_MS[i]))
  }
  if (error) {
    // State the count inspected, so a loop that ran zero times cannot read as one that tried.
    console.error(`query_sql failed after ${attempts} attempt(s):`, error.message)
    process.exitCode = 2
    return
  }
  if (attempts > 1) {
    console.log(`query_sql recovered on attempt ${attempts} of ${BACKOFF_MS.length + 1}`)
  }

  const applied = data ?? []
  const drift = applied
    .filter((r) => r.name && !repoNames.has(r.name) && !KNOWN_FILELESS.has(r.name))
    // On disk but not in the committed tree = written and never `git add`ed.
    .map((r) => ({ ...r, kind: diskNames.has(r.name) ? 'UNTRACKED' : 'MISSING' }))

  const untrackedCount = drift.filter((r) => r.kind === 'UNTRACKED').length

  console.log(
    `Migration parity — last ${WINDOW_DAYS}d: ${applied.length} applied to prod, ` +
      `${repoNames.size} versioned files ${gitBlind ? 'on disk' : 'committed'} ` +
      `(+${unversioned} unversioned legacy, ignored).`
  )

  if (drift.length === 0) {
    console.log('✓ Every migration applied to production in the window has a committed file.')
    return
  }

  console.error(
    `\n✗ ${drift.length} migration(s) applied to PRODUCTION with no committed file:\n`
  )
  for (const r of drift) {
    console.error(`  [${r.kind}] ${r.version}  ${r.name}`)
  }

  if (untrackedCount > 0) {
    console.error(
      `\nUNTRACKED (${untrackedCount}): the .sql file EXISTS in the working tree but was\n` +
        `never committed, so production has no revert path anyone else can see.\n` +
        `This is the signature of a session that applied a migration and could not push.\n` +
        `Fix: git add supabase/migrations/<version>_<name>.sql && commit.`
    )
  }

  console.error(
    `\nProd is ahead of the repo. Each of these changed production with no committed\n` +
      `revert path. Recover the SQL from PROD — do NOT retype it from a ledger entry:\n` +
      `  SELECT array_to_string(statements, E'\\n'), md5(array_to_string(statements, E'\\n'))\n` +
      `    FROM supabase_migrations.schema_migrations WHERE name = '<name>';\n` +
      `Write it byte-exactly to supabase/migrations/<version>_<name>.sql, confirm the\n` +
      `file's md5 equals the value above, commit it, and add a ledger entry if missing.\n` +
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
