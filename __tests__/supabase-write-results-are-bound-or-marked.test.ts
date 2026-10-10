import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { repoRelative, walkSourceFiles } from "./helpers/source-files"

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 AN AWAITED SUPABASE WRITE WHOSE RESULT IS DISCARDED — BAN AT ZERO.
//
// supabase-js RETURNS its error; it does not throw. So
//     await supabaseAdmin.from("t").update({...}).eq("id", x)
// with nothing bound is unreadable BY CONSTRUCTION: the statement cannot tell
// success from failure, and any try/catch around it is dead code. The 2026-10-10
// sweep found 49 of them in app/ and lib/, and the consequential ones were real:
//
//   - the weekly digest + signup reminder stored an unsubscribe token through a
//     discarded update, then mailed a link to it (and their unbound READS let a
//     failed lookup mail a person who had unsubscribed — lib/email/recipient-guards.ts);
//   - Telegram /unlink answered "Unlinked" whether or not the delete landed;
//   - early-access answered status "active" when the approval UPDATE had failed;
//   - four cursor/state writers (topshot-fmv-populate, the UFC studio backfill,
//     /api/backfill, backfill-editions) logged progress the state row never got —
//     topshot-fmv-populate behind a try/catch that could never fire.
//
// `event-cursor-writes-bind-their-error` already banned this for ONE table; the
// class is not about the table. This guard covers every write in app/, lib/ and
// components/.
//
// ⚠ THE SUPPRESSION IS THE CURATED LIST, NOT THE POPULATION. A write whose
// failure genuinely changes nothing a caller relies on — a telemetry row, a
// best-effort stamp inside a path that already failed — carries
//     // write-discarded: <why the failure is harmless>
// on one of the three lines above it. The reason is mandatory: a marker is a
// claim that the failure is harmless, and a reviewer must be able to check it.
// ─────────────────────────────────────────────────────────────────────────────

const ROOTS = ["app", "lib", "components"]
const MARKER = /write-discarded:[ \t]*\S/

// The client expression after `await`: `supabase`, `supabaseAdmin`, `sb`,
// `(supabaseAdmin as any)`, `getClient()`.
const CLIENT = String.raw`(?:\(\s*[\w.]+(?:\s+as\s+\w+)?\s*\)|[\w.]+(?:\(\))?)`
const WRITE_STMT = new RegExp(
  String.raw`^\s*await\s+${CLIENT}\s*\.from\(\s*[^)]*\)\s*\.(insert|upsert|update|delete)\(`,
)

export interface DiscardedWrite {
  file: string
  line: number
  method: string
  marked: boolean
}

/**
 * Every statement that BEGINS with `await <client>.from(...).<write>(` — i.e.
 * whose value is not assigned, destructured, returned or chained into anything.
 * Comments are stripped with the shared stripper (newlines preserved), so a
 * commented-out write is not counted; the marker is read from the RAW lines.
 */
export function discardedWrites(raw: string, file = "<src>"): DiscardedWrite[] {
  const stripped = stripComments(raw).split("\n")
  const rawLines = raw.split("\n")
  const out: DiscardedWrite[] = []
  for (let i = 0; i < stripped.length; i++) {
    if (!/^\s*await\s/.test(stripped[i])) continue
    const stmt = stripped.slice(i, i + 12).join(" ")
    const m = stmt.match(WRITE_STMT)
    if (!m) continue
    const window = rawLines.slice(Math.max(0, i - 3), i + 1).join("\n")
    out.push({ file, line: i + 1, method: m[1], marked: MARKER.test(window) })
  }
  return out
}

const files = ROOTS.flatMap((r) =>
  walkSourceFiles(r, (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts")),
)

describe("discardedWrites — the detector itself (planted defects)", () => {
  it("flags a bare awaited update, insert, upsert and delete", () => {
    const src = [
      `await supabaseAdmin.from("t").update({ a: 1 }).eq("id", 1)`,
      `await sb`,
      `  .from("t")`,
      `  .insert({ a: 1 })`,
      `await (supabaseAdmin as any).from("t").upsert({ a: 1 })`,
      `await supabase.from(STATE_TABLE).delete().eq("id", 1)`,
    ].join("\n")
    expect(discardedWrites(src).map((w) => w.method)).toEqual(["update", "insert", "upsert", "delete"])
    expect(discardedWrites(src).every((w) => !w.marked)).toBe(true)
  })

  it("does not flag a bound, returned or read statement", () => {
    const src = [
      `const { error } = await supabaseAdmin.from("t").update({ a: 1 })`,
      `const res = await sb.from("t").insert({ a: 1 })`,
      `return await sb.from("t").delete()`,
      `await sb.from("t").select("id")`,
      `;({ error: e } = await sb.from("t").update({ a: 1 }))`,
    ].join("\n")
    expect(discardedWrites(src)).toEqual([])
  })

  it("does not count a commented-out write", () => {
    expect(discardedWrites(`// await sb.from("t").update({ a: 1 })`)).toEqual([])
    expect(discardedWrites(`/* await sb.from("t").update({ a: 1 }) */`)).toEqual([])
  })

  it("a marker WITH a reason, within three lines above, marks it; a bare marker does not", () => {
    const marked = `// write-discarded: telemetry only\nawait sb.from("pipeline_runs").insert({})`
    expect(discardedWrites(marked)[0].marked).toBe(true)
    const bare = `// write-discarded:\nawait sb.from("pipeline_runs").insert({})`
    expect(discardedWrites(bare)[0].marked).toBe(false)
    const far = `// write-discarded: too far\n\n\n\nawait sb.from("t").insert({})`
    expect(discardedWrites(far)[0].marked).toBe(false)
  })
})

describe("every awaited supabase write in app/, lib/, components/ binds its result or says why not", () => {
  it("inspects the whole tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(1000)
  })

  it("no UNMARKED discarded write remains (ban at zero)", () => {
    const offenders = files
      .flatMap((f) => discardedWrites(readFileSync(f, "utf8"), repoRelative(f)))
      .filter((w) => !w.marked)
      .map((w) => `${w.file}:${w.line} .${w.method}() — bind { error } or add "// write-discarded: <reason>"`)
    expect(offenders).toEqual([])
  })
})
