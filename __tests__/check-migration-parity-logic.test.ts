import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isTransientQueryError } from "../scripts/check-migration-parity.mjs"

// ── Guard for the guard: scripts/check-migration-parity.mjs ─────────────────
//
// That script is the CONTAINMENT for the push-outage class: migrations reach
// prod via `apply_migration` (applied first, file committed afterwards by a
// human), so any session that cannot push leaves prod ahead of the repo with
// revert paths that exist only in a session transcript. It runs daily and
// nothing tested it.
//
// It is worth guarding because its own header records TWO defects already found
// in it, and both had the same shape — the check kept passing while blind:
//
//   1. It matched on VERSION. `apply_migration` stamps its own version at apply
//      time, so the committed filename's timestamp legitimately differs; a
//      version match flags real files as missing FOREVER. It now matches on NAME.
//   2. It read `readdirSync(supabase/migrations)`. A file that exists on disk
//      but was never `git add`ed satisfied that — which is EXACTLY the state the
//      job exists to catch. Observed 2026-08-10: two candy pack-EV migrations
//      sat untracked while the 3-day window reported 0. It now reads the
//      COMMITTED tree via `git ls-tree HEAD`.
//
// A third regression of the same family would be equally silent, so these
// assertions pin the two invariants at the source level and exercise the name
// parser directly. As with the brand-token guard, the parser is extracted from
// the script's own source rather than restated — a copy would drift and then
// assert nothing.

const ROOT = path.resolve(__dirname, "..")
const SCRIPT = path.join(ROOT, "scripts", "check-migration-parity.mjs")
const src = readFileSync(SCRIPT, "utf8")

/** Rebuild the script's own nameFromFile() from its source. */
function loadNameFromFile(): (file: string) => string | null {
  const m = src.match(/function nameFromFile\(file\) \{([\s\S]*?)\n\}/)
  if (!m) throw new Error("could not extract nameFromFile from check-migration-parity.mjs")
  return new Function("file", m[1]) as (file: string) => string | null
}

describe("check-migration-parity: nameFromFile is the identity function", () => {
  const nameFromFile = loadNameFromFile()

  it("strips the 14-digit version and the .sql suffix", () => {
    expect(nameFromFile("20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql")).toBe(
      "audit_20260809_allday_pack_detail_ev_lean_view"
    )
  })

  it("makes the NAME the identity, so a differing version stamp still matches", () => {
    // The real case from the run that motivated the script: prod recorded
    // version 20260809155541 while the committed file is 20260809170000_*. Both
    // must reduce to the same name or the file is reported missing forever.
    const prodStyle = nameFromFile("20260809155541_audit_20260809_allday_pack_detail_ev_lean_view.sql")
    const repoStyle = nameFromFile("20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.sql")
    expect(prodStyle).toBe(repoStyle)
    expect(prodStyle).not.toBeNull()
  })

  it("ignores unversioned legacy files rather than reporting them as drift", () => {
    // supabase/migrations holds a few unversioned legacy files (e.g.
    // add_collection_partitioning.sql). Returning a name for those would put
    // permanent noise in the report.
    expect(nameFromFile("add_collection_partitioning.sql")).toBeNull()
    expect(nameFromFile("add_profile_bio_table.sql")).toBeNull()
    expect(nameFromFile("2026_short_version.sql")).toBeNull() // not 14 digits
    expect(nameFromFile("README.md")).toBeNull()
  })

  it("keeps a name containing underscores and digits intact", () => {
    // The separator is the FIRST underscore after the version only; names
    // themselves contain both.
    expect(nameFromFile("20260812033500_audit_20260812_snapshot_log_pipeline_run.sql")).toBe(
      "audit_20260812_snapshot_log_pipeline_run"
    )
  })
})

describe("check-migration-parity: the two regressions its header records", () => {
  it("reads the COMMITTED tree (git ls-tree HEAD), not the directory listing", () => {
    // Regression 2. Reverting to readdirSync makes an untracked file satisfy the
    // check — the job's own headline scenario, and it reports 0 while blind.
    expect(src).toMatch(/ls-tree/)
    expect(src).toMatch(/HEAD/)
    const readsDirAsRepoTruth = /const\s+repoNames\s*=\s*[^\n]*readdirSync/.test(src)
    expect(
      readsDirAsRepoTruth,
      "repoNames must come from the committed tree, not readdirSync — an untracked " +
        "file would satisfy the check, which is exactly the state this job exists to catch."
    ).toBe(false)
  })

  it("matches on NAME, not version", () => {
    // Regression 1. A version-keyed comparison flags real committed files as
    // missing forever, which trains the operator to ignore the report.
    expect(src).toMatch(/repoNames\.has\(r\.name\)/)
    expect(/repoNames\.has\(r\.version\)/.test(src)).toBe(false)
  })

  it("treats a git failure as UNKNOWN (null), never as parity", () => {
    // committedNames() returns null when git cannot answer. The dangerous
    // refactor is `return new Set()` — an empty set is a value the caller can
    // compare against, so the check would proceed on a fabricated repo view.
    expect(src).toMatch(/return null/)
    expect(src).toMatch(/gitBlind/)
  })

  it("distinguishes UNTRACKED from MISSING", () => {
    // The two need different operator actions: UNTRACKED is `git add` (the SQL
    // exists), MISSING means recovering the statements from prod. Collapsing
    // them sends the operator down the wrong path.
    expect(src).toMatch(/'UNTRACKED'/)
    expect(src).toMatch(/'MISSING'/)
  })

  it("bounds the window, and keeps it configurable", () => {
    // Unbounded, the check reports ~2,000 pre-existing findings and becomes
    // noise; the bound is what makes it actionable.
    expect(src).toMatch(/MIGRATION_PARITY_WINDOW_DAYS/)
    expect(src).toMatch(/WINDOW_DAYS/)
  })

  it("sets process.exitCode rather than calling process.exit()", () => {
    // Documented Windows footgun: process.exit() mid-stdout-flush trips a libuv
    // assertion and the shell sees 127 instead of the real status.
    expect(src).toMatch(/process\.exitCode\s*=/)
    // Strip comments first — the script DOCUMENTS the footgun in prose, and
    // matching that text would assert the opposite of what we mean.
    const code = stripComments(src)
    expect(/\bprocess\.exit\(/.test(code)).toBe(false)
  })
})

describe("check-migration-parity: the fileless allowlist stays honest", () => {
  it("has no entry without a reason", () => {
    // KNOWN_FILELESS suppresses a migration from the report permanently. An
    // entry added without justification is an untracked prod change with a
    // rubber stamp.
    const block = src.slice(src.indexOf("const KNOWN_FILELESS"), src.indexOf("])", src.indexOf("const KNOWN_FILELESS")))
    const entries = [...block.matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1])
    for (const e of entries) {
      const line = block.split("\n").find((l) => l.includes(`'${e}'`)) ?? ""
      expect(line, `KNOWN_FILELESS entry ${e} needs an inline reason comment`).toMatch(/\/\//)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The transient-retry decision, tested as BEHAVIOUR rather than as source text.
//
// ⚠ WHY THIS EXISTS. `apply_migration` triggers a ~10-20s PostgREST schema-cache
// re-introspection burst (PGRST002). This check runs on a schedule, so collisions
// are routine: measured 2026-08-30, 3 of the last 4 SCHEDULED runs died on
// "Could not query the database for the schema cache. Retrying." and exited 2 —
// every one a FALSE RED. And the sentinel reports this detector as NOT CONFIGURED
// (no GITHUB_ACTIONS_READ_TOKEN), so nobody was reading it: a detector red most
// days is indistinguishable from a broken one, and a REAL parity violation would
// have looked identical.
//
// ⚠ The predicate must be right in BOTH directions, which is why this is not a
// one-sided test: retrying a genuine config error burns ~50s pretending it might
// recover, and failing to retry the schema-cache class is the false-red bug.
// ─────────────────────────────────────────────────────────────────────────────
describe("check-migration-parity: which query errors are worth retrying", () => {
  it("treats the PostgREST schema-cache class as TRANSIENT", () => {
    // The exact string production emitted on 2026-08-30.
    expect(isTransientQueryError("Could not query the database for the schema cache. Retrying.")).toBe(true)
    expect(isTransientQueryError("PGRST002: schema cache load failed")).toBe(true)
    expect(isTransientQueryError("Schema Cache reload in progress")).toBe(true)
  })

  it("does NOT retry a genuine config or permission error", () => {
    // These must fail fast. If this ever flips to true, the check will spend ~50s
    // retrying something that cannot recover, and the failure will read as flake.
    expect(isTransientQueryError("permission denied for function query_sql")).toBe(false)
    expect(isTransientQueryError("Invalid API key")).toBe(false)
    expect(isTransientQueryError("relation supabase_migrations.schema_migrations does not exist")).toBe(false)
    expect(isTransientQueryError("canceling statement due to statement timeout")).toBe(false)
  })

  it("is safe on a missing or empty message rather than throwing", () => {
    // supabase-js can hand back an error whose `message` is undefined; a throw
    // here would abort the run and read as a parity failure.
    expect(isTransientQueryError(undefined)).toBe(false)
    expect(isTransientQueryError(null)).toBe(false)
    expect(isTransientQueryError("")).toBe(false)
  })

  it("still exits 2 when the retries are exhausted — a check that cannot RUN is never a pass", () => {
    const code = stripComments(src)
    // The retry must not swallow the failure into a green exit.
    expect(code).toMatch(/process\.exitCode\s*=\s*2/)
    // And it must report how many attempts it actually made, so a loop that ran
    // zero times cannot read as one that tried.
    expect(code).toMatch(/attempts/)
  })
})
