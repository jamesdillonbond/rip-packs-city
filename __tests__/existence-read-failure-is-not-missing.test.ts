import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-09-28 — an EXISTENCE read that gates a write must not turn a failure
// into "not there yet". Five sites read `const { data } = await …` without the
// error, built a set of what exists, and wrote everything outside it:
//   - cache-refresh / cost-basis-gql-backfill: an 'unknown' / `gql:` acquisition
//     row beside a real marketplace row (the unique key includes a hash each
//     writer mints, so it cannot stop the duplicate);
//   - ingest / allday-resolve-unmapped-tail: re-hydrating editions that exist and
//     upserting over them.
// Each site now reads the error and writes nothing on a failed read. Behavioural
// tests cover cache-refresh and cost-basis; this pins all five at the source.

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"))

describe("an existence read that gates a write reads its error", () => {
  it("cache-refresh: the cached-id read 502s on error; the acquisitions read skips fallback rows", () => {
    const src = read("app", "api", "cache-refresh", "route.ts")
    expect(src).toMatch(/const \{ data, error: cachedErr \} = await supabase\s+\.from\("wallet_moments_cache"\)/)
    expect(src).toMatch(/if \(cachedErr\) \{[\s\S]{0,200}status: 502/)
    expect(src).toMatch(/const \{ data: existingRows, error: existingErr \} = await supabase\s+\.from\("moment_acquisitions"\)/)
    expect(src).toMatch(/const acqNewIds = acqReadFailed \? \[\] :/)
  })

  it("cost-basis-gql-backfill: a failed existence read fails the chunk", () => {
    const src = read("app", "api", "cost-basis-gql-backfill", "route.ts")
    expect(src).toMatch(/const \{ data: existingRows, error: existingErr \} = await/)
    expect(src).toMatch(/if \(existingErr\) \{[\s\S]{0,200}status: 502/)
  })

  it("allday-resolve-unmapped-tail: a failed editions read hydrates nothing", () => {
    const src = read("app", "api", "cron", "allday-resolve-unmapped-tail", "route.ts")
    expect(src).toMatch(/const \{ data, error: existingErr \} = await \(supabaseAdmin as any\)\s+\.from\("editions"\)/)
    expect(src).toMatch(/const missing = existingReadFailed \? \[\] : ids\.filter/)
  })

  it("ingest: a failed editions read hydrates nothing", () => {
    const src = read("app", "api", "ingest", "route.ts")
    expect(src).toMatch(/const \{ data: existingRows, error: existingErr \} = await \(supabaseAdmin as any\)\s+\.from\("editions"\)/)
    expect(src).toMatch(/const missing = existingErr \? \[\] : allKeys\.filter/)
  })
})
