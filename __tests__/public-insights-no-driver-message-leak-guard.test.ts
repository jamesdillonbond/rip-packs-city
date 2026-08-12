import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Source-level guard for the deep-audit D3 leak class on the PUBLIC insights API.
//
// WHAT HAPPENED. Every route under app/api/public/insights/** ended its failure
// path by publishing the database driver's own text to anonymous callers. It was
// not one shape but THREE, which is why a grep for the obvious one found less
// than half of it:
//
//   1. return NextResponse.json({ error: error.message }, { status: 500 })
//   2. const msg = e instanceof Error ? e.message : String(e)   // then { error: msg }
//   3. return NextResponse.json({ error }, { status: 500 })     // `error` is a bare
//      string — lib/supabase-paginate returns `error: string`, already the message
//
// Under disk-IO saturation all three published "canceling statement due to
// statement timeout" on an anon-readable route, and the concierge re-published it
// verbatim (fetchPublicInsight forwards `json.error` into the model's tool result).
//
// WHY A SOURCE TEST. There is no type that forbids this — `error` is a string and
// putting a string in a response body type-checks perfectly — so `tsc` can never
// catch a regression, and a behavioural fixture would have to be written per route
// (29 of them) to notice. One property over the directory covers the whole surface
// including routes that do not exist yet.
//
// The sanctioned replacement is boardUnavailable() from lib/insights/board-error.ts,
// which classifies server-side, logs the detail, and returns stable safe copy.

const ROOT = join(process.cwd(), "app", "api", "public", "insights")

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

// Each pattern is one of the three leak shapes above.
const LEAKS: { name: string; re: RegExp }[] = [
  {
    name: "publishes `<x>.error.message` in a response body",
    re: /\{\s*error:\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.message\b/,
  },
  {
    name: "publishes an inline `e instanceof Error ? e.message : ...` ternary",
    re: /\{\s*error:\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message/,
  },
  {
    name: "publishes a bare `{ error }` shorthand (supabase-paginate returns a string)",
    re: /NextResponse\.json\(\s*\{\s*error\s*\}\s*,/,
  },
  {
    name: "publishes a `msg` built from an error",
    re: /\{\s*error:\s*msg\s*\}/,
  },
]

describe("public /insights API never publishes a driver message", () => {
  const files = routeFiles(ROOT)

  it("finds the route files (guard is not vacuously passing)", () => {
    // A guard that scans nothing passes unconditionally and asserts nothing.
    expect(files.length).toBeGreaterThan(20)
  })

  for (const { name, re } of LEAKS) {
    it(`no route ${name}`, () => {
      const offenders = files
        .filter((f) => re.test(readFileSync(f, "utf8")))
        .map((f) => f.slice(ROOT.length + 1))
      expect(
        offenders,
        `Use boardUnavailable(err, "<board>") from @/lib/insights/board-error instead — ` +
          `these are anon-readable routes, so a Postgres message here reaches every visitor ` +
          `and the concierge. Offending: ${offenders.join(", ")}`
      ).toEqual([])
    })
  }
})
