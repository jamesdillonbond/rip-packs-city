import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

// A FAILED READ MUST NOT RENDER AS AN EMPTY RESULT SET.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Every Cowork dashboard under docs/cowork-skills/ unwraps `callMcpTool` through
// its own copy of an `extractRows(raw)` helper, and every one of them wraps the
// call in a `catch` that renders an honest "could not run" state. Measured
// 2026-09-14, that catch had NEVER FIRED on a real failure, because the helper
// did not throw:
//
//   • the live Supabase MCP server answers a missing relation with
//     `{error:{name,message}}` → fell through to `return [raw]` (1 junk row);
//   • the MCP `{isError:true, content:[{text:"permission denied…"}]}` shape →
//     the text parsed to no array → `return []`.
//
// `rpc-insights-health` then computed `empties` from the absent rows and
// published the banner **"7 surface(s) have an EMPTY backing view —
// investigate."** A renamed view, a revoked grant or a statement timeout was
// rendered as total data loss, with a red dot and a definite number.
//
// This is the repo's fabricated-value shape (`?? 0`, `|| 1`) at the transport
// layer, and the MIRROR in its worst direction: a KNOWN-healthy estate reported
// as broken. Same family as
// `failed-enrichment-does-not-assert-lock-state` (a failed per-moment enrich
// asserting `isLocked: false`).
//
// ── WHY BEHAVIOUR AND NOT SHAPE ────────────────────────────────────────────
// A grep for `isError` would pass on a comment or an unused import. This lifts
// each file's OWN helper out of its <script> and runs a payload table through
// it, so the pin is what the shipped code DOES. The genuine-empty and
// genuine-rows arms are the non-vacuity control: a helper that threw
// unconditionally would satisfy the failure arms and look like working
// detection.

const DIR = path.join(process.cwd(), "docs/cowork-skills")

/** Lift the file's own `extractRows` by brace-matching — no distance slicing. */
function liftExtractRows(html: string, file: string): (raw: unknown) => unknown[] {
  const start = html.indexOf("function extractRows(raw){")
  expect(start, `${file} must define extractRows`).toBeGreaterThan(-1)
  let depth = 0
  let i = html.indexOf("{", start)
  const open = i
  for (;;) {
    if (html[i] === "{") depth++
    else if (html[i] === "}") depth--
    if (depth === 0) break
    i++
    expect(i, `${file}: unbalanced braces in extractRows`).toBeLessThan(html.length)
  }
  expect(i, `${file}: extractRows body must be non-empty`).toBeGreaterThan(open)
  const fn = html.slice(start, i + 1)
  return new Function(`${fn}; return extractRows;`)() as (raw: unknown) => unknown[]
}

type Want = "throw" | "empty" | "rows"
const CASES: [string, unknown, Want][] = [
  // Failure shapes — each must be distinguishable from "no rows".
  ["MCP isError + text", { isError: true, content: [{ type: "text", text: 'relation "x" does not exist' }] }, "throw"],
  ["permission denied", { isError: true, content: [{ type: "text", text: "permission denied for view x" }] }, "throw"],
  ["statement timeout", { isError: true, content: [{ type: "text", text: "canceling statement due to statement timeout" }] }, "throw"],
  // ⭐ VERBATIM shape returned by the live Supabase MCP server, 2026-09-14.
  ["observed server error object", { error: { name: "HttpException", message: 'Failed to run sql query: ERROR:  42P01: relation "x" does not exist' } }, "throw"],
  ["bare prose, no array", { content: [{ type: "text", text: "Gateway timeout" }] }, "throw"],
  // Non-vacuity controls — these must NOT throw.
  ["genuine empty result set", { content: [{ type: "text", text: "[]" }] }, "empty"],
  ["genuine rows", { content: [{ type: "text", text: '[{"surface":"squeeze","n":41}]' }] }, "rows"],
  ["untrusted-data wrapper + rows", { content: [{ type: "text", text: 'note <untrusted-data-x>\n[{"surface":"squeeze","n":41}]\n</untrusted-data-x>' }] }, "rows"],
  ["null", null, "empty"],
  ["blank text", { content: [{ type: "text", text: "   " }] }, "empty"],
]

function classify(fn: (raw: unknown) => unknown[], payload: unknown): Want {
  try {
    const r = fn(payload)
    return r.length ? "rows" : "empty"
  } catch {
    return "throw"
  }
}

const ARTIFACTS = readdirSync(DIR).filter((f) => f.endsWith(".html")).sort()

describe("Cowork artifact helpers separate a failed read from an empty result set", () => {
  it("inspects the REAL artifact population, not an empty set", () => {
    // A guard that gates nothing reads as coverage in every report.
    expect(ARTIFACTS.length).toBeGreaterThanOrEqual(3)
  })

  it.each(ARTIFACTS)("%s: extractRows throws on failure and returns [] only when genuinely empty", (file) => {
    const fn = liftExtractRows(readFileSync(path.join(DIR, file), "utf8"), file)
    for (const [label, payload, want] of CASES) {
      expect(classify(fn, payload), `${file} — ${label}`).toBe(want)
    }
  })
})
