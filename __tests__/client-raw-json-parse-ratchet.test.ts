import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// Ratchet on `fetch(url).then((r) => r.json())` — parsing a body without ever
// checking the status — in `"use client"` code.
//
// ── WHY THIS IS A DEFECT AND NOT A STYLE PREFERENCE ─────────────────────────
// Our API routes answer a failure with a well-formed JSON envelope, because
// `lib/api-error.ts` builds one: `{ error, code, retryable }`. That is a
// deliberate, good property — and it is exactly what makes this pattern
// dangerous. On a 503 the body PARSES FINE, so:
//
//   • the promise RESOLVES, and any `.catch(() => {})` never fires;
//   • the error object is then cast to the success type
//     (`setSummary((s as ListingsSummaryResponse) ?? null)`);
//   • `?.rows` on it reads undefined, yielding `[]`;
//   • and the render layer states a conclusion — "No open offers match the
//     current filters.", "No events match the current filters."
//
// ⚠ Note the direction: hardening the SERVER to return a clean JSON error
// envelope made this CLIENT bug quieter, not louder. A route that once blew up
// the parse now returns something that looks like data. Two subsystems each
// correct on their own, wrong in combination.
//
// The remedy is `fetchJson` from lib/analytics/fetch-json.ts, whose own header
// already says it: "A 4xx/5xx often still carries a JSON body (an error
// envelope). Parsing and returning it would put driver text or an `{error}`
// object where the caller expects rows, so the status gates the parse."
//
// ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
// 17 sites across 5 files remain, and each needs more than a mechanical swap:
// a per-leg failure flag, a render branch ordered before the empty branch, and
// a test pinning BOTH directions. Banning today would mean shipping a 5-entry
// allowlist, which this repo has repeatedly found to be theatre. The ratchet
// stops the population GROWING while the sweep continues.
//
// ⚠ PASSING MEANS THE BLIND SPOT DID NOT GROW — it does not mean these 5 files
// are fixed. Lower the number in the same commit that converts a file; never
// raise it.
//
// Already converted (do not regress): components/analytics/ListingsDashboard.tsx
// and components/analytics/PulseDashboard.tsx, pinned behaviourally by
// __tests__/component-analytics-dashboards-failed-vs-empty.test.tsx.

const BUDGET = 17

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** Comments removed — line AND block. A guard must not count its own prose, and
 *  several of these files quote the pattern in a comment explaining their fix. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

// The backreference is what makes this precise: it matches `.then((r) => r.json())`
// only when the parameter and the receiver are the SAME identifier, so a genuine
// `.then((res) => other.json())` is not swept up.
const RAW_JSON_RX = /\.then\(\s*\(\s*(\w+)\s*\)\s*=>\s*\1\.json\(\)\s*\)/

function offenders(): string[] {
  const hits: string[] = []
  for (const f of [...walk(join(process.cwd(), "components")), ...walk(join(process.cwd(), "app"))]) {
    const raw = readFileSync(f, "utf8")
    if (!/^["']use client["']/m.test(raw)) continue
    const rel = f.slice(process.cwd().length + 1).replace(/\\/g, "/")
    stripComments(raw)
      .split("\n")
      .forEach((line, i) => {
        if (RAW_JSON_RX.test(line)) hits.push(`${rel}:${i + 1}`)
      })
  }
  return hits
}

describe("client code does not parse a response body without checking the status", () => {
  it(`has no more than ${BUDGET} unchecked parses`, () => {
    const hits = offenders()
    expect(
      hits.length,
      `Unchecked \`r.json()\` parses grew to ${hits.length} (budget ${BUDGET}).\n` +
        "Use fetchJson() from lib/analytics/fetch-json.ts — it gates the parse on\n" +
        "the status, so a 5xx error envelope cannot be cast to the row type.\n\n" +
        hits.join("\n"),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("has NO SLACK — the budget equals the live count", () => {
    // A ratchet with headroom silently licenses the next N additions. This repo
    // has already paid for the compound version: the component gate reached a
    // ~13-point unguarded branch buffer that way.
    expect(offenders().length).toBe(BUDGET)
  })

  it("is not vacuous — the matcher finds the known population", () => {
    // Guards the guard. If walk() or the regex broke, the count would read 0 and
    // this ratchet would pass forever while pointing at nothing.
    const files = new Set(offenders().map((h) => h.split(":")[0]))
    expect(files.size).toBeGreaterThan(0)
    for (const anchor of [
      "components/analytics/LoansDashboard.tsx",
      "components/analytics/SalesDashboard.tsx",
    ]) {
      expect(files, `${anchor} is a known offender and must be detected`).toContain(anchor)
    }
  })

  it("the two converted dashboards are NOT in the population", () => {
    // The regression check that matters: these were converted in the same pass
    // that installed this ratchet, so their reappearance means someone reverted
    // the fix rather than that the budget drifted.
    const files = new Set(offenders().map((h) => h.split(":")[0]))
    expect(files).not.toContain("components/analytics/ListingsDashboard.tsx")
    expect(files).not.toContain("components/analytics/PulseDashboard.tsx")
  })
})
