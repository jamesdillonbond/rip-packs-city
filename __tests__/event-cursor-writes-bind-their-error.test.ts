import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A WRITE TO `event_cursor` MUST BIND ITS ERROR — BAN AT ZERO.
//
// A block cursor is the one piece of pipeline state a re-run cannot reconstruct.
// Every indexer here logs `cursor_before` / `cursor_after` on its `pipeline_runs`
// row, and that pair is the ONLY field an operator can read to see a walk making
// progress. Twenty-one of them assigned `cursorAfter` immediately after an
// `await supabaseAdmin.from("event_cursor").update(...)` whose result was
// discarded — so supabase-js's returned error vanished and **a failed advance was
// logged as a movement**. The next tick then re-scanned the identical range while
// the run log showed the walk progressing.
//
// The backward `*-sales-history-backfill` family had the mirror image on the READ
// side and it was worse: a discarded error left the ceiling at CEILING_INIT, the
// TOP of the walk, and the tick wrote that high block back over the real cursor —
// discarding the whole backward walk in one run, at `ok: true`.
//
// ⚠ WHY THIS IS A SEPARATE GUARD FROM THE READ RATCHET.
// `consequential-read-binds-its-error-ratchet` matches `const { ... } = await
// supabaseAdmin`, which a bare `await supabaseAdmin.from(...).update(...)` does
// not have — there is nothing destructured to inspect. The two guards therefore
// cover disjoint syntax, and neither would have found the other's population.
//
// ⚠ WHY A BAN AND NOT A RATCHET. The read population is large and mostly benign,
// so it is ratcheted. Cursor writes are few, uniform, and every one of them is
// consequential by construction, so zero is the right target and an allowlist
// would be theatre.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(process.cwd(), "app", "api")

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) routeFiles(p, out)
    else if (e === "route.ts") out.push(p)
  }
  return out
}

interface CursorWrite {
  file: string
  line: number
  head: string
  bound: boolean
}

/**
 * A cursor WRITE: a `.from("event_cursor")` whose statement also calls `.update(`
 * or `.upsert(`. Bound = the statement head destructures `error`.
 *
 * Comments are stripped first with the SHARED stripper, so a commented-out write
 * cannot be counted and a comment mentioning `event_cursor` cannot be flagged.
 */
export function cursorWrites(src: string, file = "<src>"): CursorWrite[] {
  const lines = stripComments(src).split("\n")
  const found: CursorWrite[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('.from("event_cursor")')) continue
    // The chain continues on the following lines; 5 is generous for
    // `.update({...}).eq(...)` and for a single-line `.upsert({...}, {...})`.
    if (!/\.(update|upsert)\(/.test(lines.slice(i, i + 5).join("\n"))) continue
    let j = i
    while (j > 0 && !/=\s*await\b|^\s*await\b/.test(lines[j])) j--
    const head = lines[j]
    found.push({
      file,
      line: j + 1,
      head: head.trim(),
      bound: /const\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await/.test(head),
    })
  }
  return found
}

const all = routeFiles(ROOT).flatMap((f) => cursorWrites(readFileSync(f, "utf8"), f))

describe("every event_cursor write in a route binds its error", () => {
  // ⚠ A guard that inspects nothing passes. routeFiles() returns [] for a root
  // that does not exist, and stripComments has blanked real source three times in
  // this repo's history — either failure reads as a clean ban. These floors are
  // the only thing that separates "zero violations" from "zero inspected".
  it("is not vacuous: it found the cursor-write population", () => {
    expect(all.length).toBeGreaterThanOrEqual(20)
    expect(new Set(all.map((w) => w.file)).size).toBeGreaterThanOrEqual(10)
  })

  it("is not vacuous: the detector distinguishes bound from unbound", () => {
    // A positive control on the DETECTOR, not on the tree — it must be able to
    // SEE a violation, or a green result means nothing. (Proving a watcher can
    // see a failure before relying on it is this repo's standing rule.)
    const bad = `
      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: 1 })
        .eq("id", "x")
    `
    const good = `
      const { error: e } = await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: 1 })
        .eq("id", "x")
    `
    expect(cursorWrites(bad).map((w) => w.bound)).toEqual([false])
    expect(cursorWrites(good).map((w) => w.bound)).toEqual([true])
    // And a read must not be counted as a write.
    const read = `
      const { data } = await supabaseAdmin
        .from("event_cursor")
        .select("last_processed_block")
        .eq("id", "x")
    `
    expect(cursorWrites(read)).toEqual([])
  })

  it("has no unbound cursor writes", () => {
    const bad = all.filter((w) => !w.bound)
    expect(
      bad.map((w) => `${w.file}:${w.line}  ${w.head}`),
      "A discarded cursor-write error turns a FAILED advance into a LOGGED movement:\n" +
        "`cursorAfter` is assigned whether or not the write landed, so the run log shows\n" +
        "the walk progressing while the stored cursor has not moved and the next tick\n" +
        "re-scans the identical range. Bind it:\n" +
        '    const { error: cursorWriteErr } = await supabaseAdmin.from("event_cursor")…\n' +
        "    if (cursorWriteErr) throw new Error(...)\n" +
        "so the outer catch marks the run ok:false and cursor_after keeps its real value.\n" +
        "Offenders:",
    ).toEqual([])
  })
})
