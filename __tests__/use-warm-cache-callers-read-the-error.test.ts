// @vitest-environment node
//
// Tree-walk guard (2026-11-02): every `useWarmCache` call site must CONSUME the
// hook's `error`. The hook returns `{ data, loading, error, refresh }`; a caller
// that reads only `data` / `loading` renders its empty branch when the fetcher
// throws, so a 5xx becomes "No moments in your wallet", "0 pts", "No lineups
// saved yet" (four RTR / Fast Break panels, fixed the same day).
//
// The rule is per CALL: a destructured result must name `error`; a bound result
// (`const x = useWarmCache(...)`) must be read as `x.error` somewhere in the file.
// Exceptions are a curated SUPPRESSION list with a reason each — the suppression
// is the claim, not the default.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOT = path.resolve(__dirname, "..")
const DIRS = ["app", "components", "lib"]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = path.join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(p)
  }
  return out
}

/** `${relative file}::${bound name or destructured data alias}` → reason. */
const SUPPRESSED: Record<string, string> = {
  "components/packs/PackPageClient.tsx::liveListingsData":
    "decorative live-ask overlay on rows that already render; a failed read shows no overlay and claims nothing",
  "app/(collections)/[collection]/collection/CollectionTabClient.tsx::savedWalletsData":
    "saved-wallets prefetch feeding a picker default; no copy concludes from its absence",
}

interface Site { file: string; name: string; consumesError: boolean }

function sites(): Site[] {
  const out: Site[] = []
  for (const d of DIRS) {
    for (const abs of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/")
      if (rel === "lib/warmup/WarmupContext.tsx") continue
      const src = stripComments(readFileSync(abs, "utf8"))
      if (!src.includes("useWarmCache")) continue
      const destructured = /const\s*\{([^}]*)\}\s*=\s*useWarmCache\b/g
      let m: RegExpExecArray | null
      while ((m = destructured.exec(src))) {
        const fields = m[1]
        const dataAlias = (fields.match(/\bdata\s*:\s*(\w+)/) ?? [])[1] ?? "data"
        out.push({ file: rel, name: dataAlias, consumesError: /\berror\b/.test(fields) })
      }
      const bound = /const\s+(\w+)\s*=\s*useWarmCache\b/g
      while ((m = bound.exec(src))) {
        const name = m[1]
        out.push({ file: rel, name, consumesError: new RegExp(`\\b${name}\\.error\\b`).test(src) })
      }
    }
  }
  return out
}

describe("every useWarmCache caller consumes its error", () => {
  const all = sites()

  it("inspects a non-zero population (a guard that sees nothing has not passed)", () => {
    // Measured 2026-11-02: 9 call sites across 5 files. A drop below means the
    // regexes stopped matching a call shape, not that callers went away.
    expect(all.length).toBeGreaterThanOrEqual(9)
  })

  it("no call site ignores the error unless suppressed with a reason", () => {
    const offenders = all
      .filter((s) => !s.consumesError && !SUPPRESSED[`${s.file}::${s.name}`])
      .map((s) => `${s.file} :: ${s.name}`)
    expect(offenders, "read the hook's `error` and render a failed-read branch, or suppress with a reason").toEqual([])
  })

  it("every suppression still names a live call site (no stale allowlist)", () => {
    const live = new Set(all.map((s) => `${s.file}::${s.name}`))
    const stale = Object.keys(SUPPRESSED).filter((k) => !live.has(k))
    expect(stale).toEqual([])
  })
})
