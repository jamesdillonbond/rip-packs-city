import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — FMV recalc PostgREST .in() chunking.
//
// Per CLAUDE.md (fmv-recalc silent stall, RESOLVED dd84526): an unchunked
// `.in("edition_id", …)` on a ~1,100-edition page blew past PostgREST's URL cap
// and supabase-js surfaced it as a non-throwing deleteError, so the route
// crashed silently inside after() before log_pipeline_run — a fully invisible
// stall. The fix chunks every `.in()` site at 500 (PostgREST also clamps an
// unpaginated response to 1000 rows, so 500 is the safe chunk).
//
// This guard reads the route source and asserts every *_CHUNK constant stays
// <= 500 and that the known chunk sites still exist — so re-introducing a large
// or removed chunk (the exact regression that caused the stall) fails here.

const REPO = process.cwd()
const ROUTE = path.join(REPO, "app", "api", "fmv-recalc", "route.ts")
const MAX_CHUNK = 500

const src = readFileSync(ROUTE, "utf8")

function chunkConstants(): { name: string; value: number }[] {
  const re = /const\s+(\w*CHUNK\w*)\s*=\s*(\d+)/g
  const out: { name: string; value: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push({ name: m[1], value: Number(m[2]) })
  return out
}

describe("invariant: fmv-recalc chunks every .in() at <= 500", () => {
  const chunks = chunkConstants()

  it("still declares the id/meta/ask chunk constants (chunking not removed)", () => {
    const names = chunks.map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(["IN_CHUNK", "META_CHUNK", "ASK_CHUNK"]))
  })

  it("no chunk size exceeds the 500-row PostgREST-safe bound", () => {
    const offenders = chunks.filter((c) => c.value > MAX_CHUNK)
    expect(
      offenders,
      `These chunk sizes risk the silent PostgREST truncation/URL-cap stall:\n` +
        offenders.map((o) => `  ${o.name} = ${o.value}`).join("\n"),
    ).toEqual([])
  })

  it("each chunked loop paginates and logs on error (fatal path reaches log_pipeline_run)", () => {
    // The dd84526 fix added log_pipeline_run to the fatal-catch + chunk error
    // paths so a future silent stall surfaces in pipeline_runs. Guard that the
    // route still references both, so the observability isn't refactored away.
    expect(src).toMatch(/log_pipeline_run/)
    expect(src).toMatch(/chunkErr|chunk fetch error/)
  })
})
