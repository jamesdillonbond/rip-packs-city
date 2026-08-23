#!/usr/bin/env node
/**
 * Recover migration .sql files for migrations that were APPLIED TO PRODUCTION
 * but never committed — the state `check-migration-parity.mjs` detects.
 *
 * WHY THIS EXISTS
 * ---------------
 * migration-parity has been ENFORCING since 2026-08-20 and its failure message
 * ends with a hand recipe: query `statements` out of
 * supabase_migrations.schema_migrations, write it byte-exactly to
 * supabase/migrations/<version>_<name>.sql, confirm the md5. That recipe is
 * correct and nobody should be running it by hand — it is per-migration, it is
 * transcription, and the sessions that trigger it are precisely the ones that
 * could not use git in the first place (workspace disk full, git-proxy 403, a
 * Cowork cloud session with no repo attached).
 *
 * 2026-08-23 made the case concrete: one Cowork session applied 23 migrations
 * via MCP in a day and could not commit any of them, so 23 production changes
 * had a revert path that existed only in a chat transcript.
 *
 * WHAT IT DOES
 * ------------
 * Reads only. For every applied migration in the window with no file on disk, it
 * pulls the stored statements, writes the file, and VERIFIES the bytes it wrote
 * against the md5 prod computes over the same slice. A mismatch is a hard error,
 * because the whole point is a byte-exact record, not an approximate one.
 *
 * ⚠ TWO THINGS THAT WILL BITE YOU IF YOU CHANGE THIS
 *   1. NO TRAILING NEWLINE. `array_to_string(statements, E'\n')` produces none,
 *      so appending one makes every md5 disagree with prod. Verified 2026-08-23
 *      across 8 recovered files.
 *   2. MATCH ON NAME, NOT VERSION. `apply_migration` stamps its own version, so
 *      a committed filename's timestamp legitimately differs from prod's. This
 *      script writes prod's version into the filename because it has it, but
 *      parity is judged on the name.
 *
 * USAGE
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/recover-fileless-migrations.mjs [--window 3] [--dry-run]
 *
 * Exit: 0 wrote cleanly (or nothing to do) · 1 an md5 mismatch · 2 could not run.
 * It never commits. Review the diff, then `git add supabase/migrations`.
 */
import { readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const MIGRATIONS_DIR = 'supabase/migrations'
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const WINDOW_DAYS = Number(
  (argv.includes('--window') ? argv[argv.indexOf('--window') + 1] : null) ??
    process.env.MIGRATION_PARITY_WINDOW_DAYS ??
    3
)

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const nameFromFile = (f) => (/^(\d{14})_(.+)\.sql$/.exec(f) ?? [])[2] ?? null

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exitCode = 2
    return
  }
  if (!Number.isFinite(WINDOW_DAYS) || WINDOW_DAYS <= 0) {
    console.error(`--window must be a positive number of days (got ${WINDOW_DAYS})`)
    process.exitCode = 2
    return
  }

  const dir = resolve(process.cwd(), MIGRATIONS_DIR)
  const onDisk = new Set()
  for (const f of readdirSync(dir)) {
    const n = nameFromFile(f)
    if (n) onDisk.add(n)
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // query_sql() is the service_role-only reader; schema_migrations is not exposed
  // through PostgREST directly. Same access path as check-migration-parity.mjs.
  const { data, error } = await supabase.rpc('query_sql', {
    query: `SELECT version,
                   name,
                   array_to_string(statements, E'\\n')      AS sql,
                   md5(array_to_string(statements, E'\\n'))  AS md5
              FROM supabase_migrations.schema_migrations
             WHERE version >= to_char(now() - interval '${WINDOW_DAYS} days', 'YYYYMMDD') || '000000'
             ORDER BY version`,
  })
  if (error) {
    console.error('query_sql failed:', error.message)
    process.exitCode = 2
    return
  }

  const missing = (data ?? []).filter((r) => r.name && !onDisk.has(r.name))
  if (missing.length === 0) {
    console.log(`No fileless migrations in the last ${WINDOW_DAYS}d. Nothing to recover.`)
    return
  }

  console.log(`${missing.length} applied migration(s) with no file, window ${WINDOW_DAYS}d:\n`)
  let bad = 0
  for (const r of missing) {
    const file = `${r.version}_${r.name}.sql`
    const path = resolve(dir, file)
    if (DRY) {
      console.log(`  [dry-run] ${file}  (${(r.sql ?? '').length} bytes)`)
      continue
    }
    // No trailing newline — see the header note.
    writeFileSync(path, r.sql ?? '', 'utf8')
    const wrote = md5(readFileSync(path, 'utf8'))
    const ok = wrote === r.md5
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'MD5!'} ${file}`)
    if (!ok) console.error(`       prod ${r.md5}  wrote ${wrote}`)
  }

  if (DRY) {
    console.log('\nDry run — nothing written.')
    return
  }
  if (bad > 0) {
    console.error(
      `\n${bad} file(s) do not match the md5 prod computes over the same slice. ` +
        `Do NOT commit them — a byte-inexact record is worse than a missing one.`
    )
    process.exitCode = 1
    return
  }
  console.log(
    `\nWrote ${missing.length} file(s), all md5-verified against prod.\n` +
      `Review the diff, then: git add ${MIGRATIONS_DIR} && git commit`
  )
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
