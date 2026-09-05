import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { stripSql } from "../scripts/lib/strip-sql.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// Every NEW migration that creates a function in `public` must STATE its
// anon-execute decision. Silence is not a decision.
//
// ⚠ WHY. A new function in `public` is anon-EXECUTABLE BY DEFAULT on this
// database — it inherits both a PUBLIC grant and, because this DB carries
// `ALTER DEFAULT PRIVILEGES` for anon + authenticated, explicit per-role acl
// rows. Nothing warns you. And `check_secdef_anon_exec_drift()`, the standing
// guard on "what can anon call?", considers SECURITY DEFINER functions ONLY, so
// every SECURITY INVOKER function is outside it BY CONSTRUCTION however often it
// runs green.
//
// That gap was measured on 2026-08-16. Eight anon-executable functions had NO
// caller anywhere — not in pg_proc, not in a view, not in cron, not in the repo —
// and two of them are pathological to invoke:
//
//   compute_pack_ev_from_pool_tier_weighted   45,762 ms · ~2.29M buffers (~17.4 GB)
//   get_wallet_cache_count                    39,450 ms
//
// Both reachable by an unauthenticated caller: the anon key ships in the browser
// bundle and PostgREST exposes every public function at /rest/v1/rpc/<name>.
// `proxy.ts` is irrelevant — route-gating is not data-gating. Severity is
// AVAILABILITY, not confidentiality (they are INVOKER, so the caller's own RLS
// applies), but on a disk-IO-budgeted 2 GB instance a handful of concurrent calls
// is an outage, from an anonymous client, for free. All eight are now revoked;
// this guard is what stops the population growing back silently.
//
// ⚠ A `REVOKE ... FROM PUBLIC` ALONE DOES NOT SATISFY THIS, and that is the
// hard-won part. Because of ALTER DEFAULT PRIVILEGES, the explicit anon /
// authenticated rows SURVIVE a PUBLIC-only revoke — a migration doing exactly
// that measured `has_function_privilege('anon', …) = true` immediately after
// apply, and took the drift check 0 -> 1, while its `proacl` text looked clean.
// The correct form names all three:
//     REVOKE EXECUTE ON FUNCTION public.foo(...) FROM PUBLIC, anon, authenticated;
//
// ── THE ESCAPE HATCH IS DELIBERATE AND WILL OFTEN BE THE RIGHT ANSWER ─────────
// Plenty of functions SHOULD be anon-executable: the collection tabs were
// un-gated 2026-07-17 and /share/[wallet] is public by design, so the wallet and
// analytics RPCs behind them are legitimately reachable. `serial_fmv_estimate` is
// the documented case that MUST stay anon-executable — it is reached through
// `get_wallet_moments_with_fmv` and the anon-readable
// `topshot_underpriced_serials_board` view, and an invoker-mode view executes its
// callee AS THE CALLER.
//
// ⚠ And a SNAPSHOT migration (the `CREATE OR REPLACE` no-ops committed to make a
// function pinnable) must use the marker rather than add a revoke: unlike views
// and reloptions, `CREATE OR REPLACE FUNCTION` does NOT reset a function's ACL,
// so adding a REVOKE there would CHANGE production while pretending to be a
// byte-identical no-op.
//
// So: either revoke, or say why not, per FUNCTION NAME:
//     -- anon-exec: intentional — public board reads this via <view>
//
// ⚠ KEYED PER FUNCTION NAME, not per file — a file hardening function A must not
// vouch for function B. That is why the sibling view guard is per view name: a
// real migration creates two views and hardens only one though its header says
// it meant to do both.
//
// ⚠ CUTOFF, and why this is not vacuous. 276 of the 577 existing migrations
// create a public function; enumerating them would be noise, and an applied
// migration is history — editing it cannot change production. So this applies
// only from CUTOFF forward, and today that population is ZERO. Per this repo's
// own rule — "a not-vacuous check must be satisfiable at a population of zero" —
// the guard therefore asserts THE WALK AND THE DETECTOR against synthetic
// fixtures, not that any file is currently in scope. It becomes load-bearing the
// moment someone adds a migration, which is exactly when it is needed.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations")

/** Applies to migrations from this version forward. Everything earlier is history. */
const CUTOFF = "20260817000000"

/**
 * Blank comment bodies, preserving offsets.
 *
 * ⚠ OFFSET PRESERVATION IS LOAD-BEARING HERE SPECIFICALLY, which is why this
 * guard passes no options: `statesDecision` matches
 * `REVOKE[\s\S]{0,200}?…public.<fn>\s*\(` — a BOUNDED window. A stripper that
 * collapsed a 300-character comment to one space would pull a REVOKE and a
 * function name inside a window they were never within, and this guard would
 * vouch for a decision the file does not state.
 *
 * ⚠ LITERALS ARE DELIBERATELY KEPT. Unlike the RLS guard, this one is looking
 * for REVOKE statements, not for DDL that a `format()` string could fake.
 *
 * Migrated to the shared SQL lexer 2026-09-05. The local version it replaced
 * stripped only LINE-START `--` comments (`/^\s*--.*$/gm`), so a trailing
 * comment after code was invisible to it, and `.` does not match `\r` so the
 * strip no-opped entirely on a CRLF file.
 */
const stripComments = (sql: string): string => stripSql(sql) as string

/** Function names created in `public` by this SQL (comments already stripped). */
export function createdPublicFunctions(code: string): string[] {
  const out = new Set<string>()
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)\s*\(/gi
  for (const m of code.matchAll(re)) out.add(m[1])
  return [...out]
}

/**
 * Does the file state a decision for `fn`? Either a REVOKE naming the function
 * AND the anon role, or a marker line naming the function with a reason.
 * ⚠ Takes the RAW sql for the marker (markers live in comments) and the
 * comment-stripped code for the REVOKE (so a commented-out revoke cannot count).
 */
export function statesDecision(raw: string, code: string, fn: string): boolean {
  // ⚠ `EXECUTE` **or** `ALL`. EXECUTE is the ONLY privilege a function has, so
  // `REVOKE ALL ON FUNCTION f(...)` and `REVOKE EXECUTE ON FUNCTION f(...)` are
  // the same statement in different words — and `ALL` is the form a careful
  // author reaches for, since it also covers any privilege Postgres might add.
  //
  // 🚨 THIS COST A RED `main`. Two migrations on 2026-08-23
  // (`series_detail_rollup`, `get_series_detail_reads_the_rollup`) revoked
  // correctly with `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated`,
  // and this guard reported them as having stated no decision at all. Verified
  // against the live database before changing anything: `has_function_privilege`
  // for both functions reads anon=false, authenticated=false, service_role=true.
  // **Production was right and the guard was wrong** — it was reading a SPELLING,
  // which is the second time in one day this exact file has failed a correct,
  // verified decision over its wording.
  //
  // ⚠ This widens the accepted spelling and NOTHING else. `\bpublic\.${fn}\s*\(`
  // still demands a function signature, so `REVOKE ALL ON TABLE public.<fn>`
  // cannot vouch for a function of the same name, and the trailing `\banon\b` still
  // rejects a PUBLIC-only revoke. Both are pinned as controls below.
  const revoke = new RegExp(
    `REVOKE[\\s\\S]{0,200}?(?:EXECUTE|ALL)[\\s\\S]{0,200}?\\bpublic\\.${fn}\\s*\\([\\s\\S]{0,300}?\\banon\\b`,
    "i",
  )
  if (revoke.test(code)) return true
  return raw
    .split("\n")
    .some((line) => /anon-exec:\s*\S+/i.test(line) && new RegExp(`\\b${fn}\\b`).test(line))
}

function inScope(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const v = f.split("_")[0]
      return /^\d{14}$/.test(v) && v >= CUTOFF
    })
}

describe("a new migration must state its anon-execute decision for every public function it creates", () => {
  it("every in-scope migration either revokes anon EXECUTE or says why not", () => {
    const offenders: string[] = []
    for (const file of inScope()) {
      const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
      const code = stripComments(raw)
      for (const fn of createdPublicFunctions(code)) {
        if (!statesDecision(raw, code, fn)) offenders.push(`${file} → public.${fn}`)
      }
    }
    expect(
      offenders,
      "New functions in `public` are anon-EXECUTABLE BY DEFAULT on this database, and " +
        "check_secdef_anon_exec_drift() is structurally blind to SECURITY INVOKER ones. " +
        "Either add:\n" +
        "    REVOKE EXECUTE ON FUNCTION public.<fn>(<args>) FROM PUBLIC, anon, authenticated;\n" +
        "(all three roles — a PUBLIC-only revoke leaves the explicit anon rows this DB " +
        "grants via ALTER DEFAULT PRIVILEGES), or state the decision:\n" +
        "    -- anon-exec: intentional — <why> (<fn>)\n" +
        "Use the marker for a SNAPSHOT migration: CREATE OR REPLACE FUNCTION does not " +
        "reset a function ACL, so a revoke there would change production.\nOffenders:",
    ).toEqual([])
  })

  // ── not-vacuous: the walk and the detector, asserted at population zero ──

  it("NOT VACUOUS: the walk reads real migrations and the cutoff is in the right format", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))
    expect(all.length).toBeGreaterThan(100)
    expect(CUTOFF).toMatch(/^\d{14}$/)
    // Sanity: the corpus really does contain function-creating migrations, so a
    // detector returning [] for everything would be wrong rather than lucky.
    const anyCreates = all.some((f) =>
      createdPublicFunctions(stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"))).length > 0,
    )
    expect(anyCreates).toBe(true)
  })

  it("NOT VACUOUS: the detector classifies synthetic fixtures correctly", () => {
    const create = "CREATE OR REPLACE FUNCTION public.zz_probe(p_x uuid)\nRETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n"
    expect(createdPublicFunctions(create)).toEqual(["zz_probe"])

    // Silence fails.
    expect(statesDecision(create, create, "zz_probe")).toBe(false)

    // A correct revoke passes.
    const revoked = create + "REVOKE EXECUTE ON FUNCTION public.zz_probe(uuid) FROM PUBLIC, anon, authenticated;\n"
    expect(statesDecision(revoked, stripComments(revoked), "zz_probe")).toBe(true)

    // ⚠ A PUBLIC-ONLY revoke must NOT pass — the exact drift this repo shipped.
    const publicOnly = create + "REVOKE EXECUTE ON FUNCTION public.zz_probe(uuid) FROM PUBLIC;\n"
    expect(statesDecision(publicOnly, stripComments(publicOnly), "zz_probe")).toBe(false)

    // ⚠ `REVOKE ALL ON FUNCTION` passes — the same statement in different words,
    // and the spelling that reddened main on 2026-08-23 while production was
    // correct.
    const revokedAll = create + "REVOKE ALL ON FUNCTION public.zz_probe(uuid) FROM PUBLIC, anon, authenticated;\n"
    expect(statesDecision(revokedAll, stripComments(revokedAll), "zz_probe")).toBe(true)

    // ⚠ …but ONLY as a function revoke. A TABLE of the same name must not vouch
    // for the function — without this, widening to `ALL` could be satisfied by an
    // unrelated `REVOKE ALL ON TABLE`, which grants nothing about EXECUTE.
    const tableOnly = create + "REVOKE ALL ON TABLE public.zz_probe FROM PUBLIC, anon, authenticated;\n"
    expect(statesDecision(tableOnly, stripComments(tableOnly), "zz_probe")).toBe(false)

    // ⚠ And a PUBLIC-only `REVOKE ALL` must still fail, exactly as the EXECUTE
    // form does — widening the verb must not weaken the role requirement.
    const allPublicOnly = create + "REVOKE ALL ON FUNCTION public.zz_probe(uuid) FROM PUBLIC;\n"
    expect(statesDecision(allPublicOnly, stripComments(allPublicOnly), "zz_probe")).toBe(false)

    // A marker naming the function passes.
    const marked = "-- anon-exec: intentional — public board calls zz_probe via a view\n" + create
    expect(statesDecision(marked, stripComments(marked), "zz_probe")).toBe(true)

    // ⚠ A marker that does NOT name the function must not vouch for it — per-name,
    // so a file hardening A cannot cover B.
    const wrongName = "-- anon-exec: intentional — this is about some_other_fn\n" + create
    expect(statesDecision(wrongName, stripComments(wrongName), "zz_probe")).toBe(false)

    // ⚠ A COMMENTED-OUT revoke must not count as one.
    const commented = create + "-- REVOKE EXECUTE ON FUNCTION public.zz_probe(uuid) FROM PUBLIC, anon;\n"
    expect(statesDecision(commented.replace(/anon-exec:/g, ""), stripComments(commented), "zz_probe")).toBe(false)
  })
})
