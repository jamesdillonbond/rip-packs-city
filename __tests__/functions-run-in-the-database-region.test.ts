import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// ⚠ WHY THIS GUARD EXISTS.
//
// The Supabase project (bxcqstmqfzmuolpuynti) lives in AWS us-west-2 (Oregon).
// Until 2026-10-14 vercel.json named no region, so every Vercel function ran in
// the default `iad1` (Washington, DC) and EVERY server-side read crossed the
// continent. Measured 2026-10-14, same query on both sides:
//
//   profile_bio `username ilike $1` (the /profile resolve step)
//     DB execution (pg_stat_statements, 238,469 calls)   mean 0.14 ms
//     as seen by the iad1 function (40 log lines, 24 h)   97-177 ms, median ~118 ms
//
// ~99% of a trivial read was the network hop. Pages that fire several reads
// (pack detail fires ~8, edition pages carry the market-cap tile) spent their
// 5-8 s read budgets on it, which is what the "read exceeded 5000ms / 8000ms"
// runtime-error groups were. `pdx1` (Portland) is Vercel's us-west-2 region.
//
// If the DATABASE ever moves, this guard is the reminder that the function
// region has to move with it: update both constants together.

const DB_AWS_REGION = "us-west-2"
const VERCEL_REGION_FOR: Record<string, string> = { "us-west-2": "pdx1" }

const vercelJson = JSON.parse(readFileSync("vercel.json", "utf8")) as { regions?: string[] }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe("Vercel functions run in the database's region", () => {
  it("vercel.json pins exactly the region co-located with the Supabase project", () => {
    expect(vercelJson.regions).toEqual([VERCEL_REGION_FOR[DB_AWS_REGION]])
  })

  it("no route overrides it with a per-segment preferredRegion", () => {
    const files = walk("app")
    expect(files.length).toBeGreaterThan(100) // the walk inspected the tree
    const offenders = files.filter((f) => /export\s+const\s+preferredRegion\b/.test(readFileSync(f, "utf8")))
    expect(offenders).toEqual([])
  })
})
