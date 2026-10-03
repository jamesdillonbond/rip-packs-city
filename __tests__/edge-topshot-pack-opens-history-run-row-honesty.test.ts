// R123 residual (2026-10-03): ingest-topshot-pack-opens-history already held its
// cursor on a failed cursor WRITE (cursorWriteErr → ok=false), but (1) the run
// row's `error` was `err || rerr`, so a cursor-write-only failure published
// ok=false with an EMPTY error, and (2) logRun discarded the pipeline_runs insert
// error. Both are fixed to match its byte-level sibling ingest-allday-pack-opens.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = readFileSync(
  path.resolve(__dirname, "../supabase/functions/ingest-topshot-pack-opens-history/index.ts"),
  "utf8",
)
const logRunBody = SRC.slice(SRC.indexOf("async function logRun("), SRC.indexOf("Deno.serve("))

describe("ingest-topshot-pack-opens-history run row is honest about its own failures", () => {
  it("is not vacuous: the function still tracks a cursor write error", () => {
    expect(SRC).toMatch(/cursorWriteErr = await setCursor\(/)
  })

  it("names a cursor-write failure in the run row's error", () => {
    expect(SRC).toMatch(/ok \? null : \(err \|\| rerr \|\| \(cursorWriteErr \? `cursor write: \$\{cursorWriteErr\}` : null\)\)/)
    expect(SRC).not.toMatch(/ok \? null : \(err \|\| rerr\)\)/)
  })

  it("binds the pipeline_runs insert error instead of discarding it", () => {
    expect(logRunBody).toMatch(/const \{ error: logErr \} = await supabase\.from\("pipeline_runs"\)\.insert\(/)
    expect(logRunBody).toContain("[pipeline_runs-insert-failed]")
    expect(logRunBody).not.toMatch(/^\s*await supabase\.from\("pipeline_runs"\)\.insert\(/m)
  })
})
