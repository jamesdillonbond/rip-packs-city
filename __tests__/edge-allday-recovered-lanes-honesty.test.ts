import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// The two AllDay lanes recovered from deployed source on 2026-10-14 (register R21):
// `backfill-allday-dist-opened` (pg_cron 27) and `resolve-allday-pull-editions` (pg_cron 22).
// Both were uncommitted, gated by a HARDCODED literal, and ignored every returned `error`.
// These handlers call Deno.serve at import, so vitest cannot run them; the pins are on
// CODE (comments stripped — each file's header describes the old defects in prose).

const ROOT = path.resolve(__dirname, "..")
const read = (slug: string) =>
  stripComments(readFileSync(path.join(ROOT, "supabase", "functions", slug, "index.ts"), "utf8"))

describe("backfill-allday-dist-opened — no fabricated zero, no failed read as done", () => {
  const code = read("backfill-allday-dist-opened")

  it("is gated by the shared Vault gate under its OWN slug, with no literal", () => {
    expect(code).toMatch(/cronGate\(req,\s*sb,\s*"backfill-allday-dist-opened"\)/)
    expect(code).not.toMatch(/const\s+GATE\s*=/)
  })

  it("never writes `?? 0` into opened_count — a missing total is a failure, not '0 opened'", () => {
    expect(code).not.toMatch(/opened_count\s*:\s*[^,}]*\?\?\s*0/)
    // The count function refuses a reply with no numeric totalCount.
    expect(code).toMatch(/typeof total\s*!==\s*"number"/)
  })

  it("a failed batch read is a 500, never {done:true}", () => {
    expect(code).toMatch(/error:\s*readErr\s*\}\s*=\s*await sb\.from\("allday_pack_supply"\)/)
    const readGuard = code.indexOf("if(readErr)")
    const done = code.indexOf("done:true")
    expect(readGuard, "the read error is never checked").toBeGreaterThan(-1)
    expect(readGuard, "the error check must precede the 'done' answer").toBeLessThan(done)
  })

  it("reads the update's returned error before counting the dist", () => {
    expect(code).toMatch(/error:\s*wErr\s*\}\s*=\s*await sb\.from\("allday_pack_supply"\)\.update/)
    expect(code.indexOf("if(wErr)")).toBeLessThan(code.indexOf("done++"))
  })
})

describe("resolve-allday-pull-editions — every read and write error is read", () => {
  const code = read("resolve-allday-pull-editions")

  it("is gated by the shared Vault gate under its OWN slug, with no literal", () => {
    expect(code).toMatch(/cronGate\(req,\s*sb,\s*"resolve-allday-pull-editions"\)/)
    expect(code).not.toMatch(/const\s+GATE\s*=/)
  })

  it("a failed candidate read is a 500, never 'none unresolved'", () => {
    expect(code.indexOf("if(rowsErr)")).toBeGreaterThan(-1)
    expect(code.indexOf("if(rowsErr)")).toBeLessThan(code.indexOf("none unresolved"))
  })

  it("a failed FMV read writes nothing — it must not null out a priceable pull", () => {
    expect(code).toMatch(/if\(fmvErr\)\s*return\s*\{ok:false/)
    expect(code.indexOf("if(fmvErr)")).toBeLessThan(code.indexOf('from("allday_pack_pull").update'))
  })

  it("`resolved` counts rows WRITTEN — the update's error is read first", () => {
    expect(code).toMatch(/error:\s*wErr\s*\}\s*=\s*await sb\.from\("allday_pack_pull"\)\.update/)
    expect(code.indexOf("if(wErr)")).toBeLessThan(code.indexOf("resolved++"))
  })
})
