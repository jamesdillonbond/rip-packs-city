import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// Guards the D2 class: a cron gate key hardcoded into an edge function.
//
// This repo is PUBLIC. Eight pack ingest/backfill/compute edge functions each
// carried `const GATE = "rpc_pls_…"` as their SOLE auth on a service-role
// writer, so the key to a prod write path was world-readable — and mirrored
// into ~9 committed docs. They are now read from per-function edge secrets and
// fail CLOSED when unset.
//
// The check is directory-driven so a NEW edge function is covered automatically
// rather than when someone remembers to extend a list.

const FN_DIR = join(process.cwd(), "supabase", "functions")

function edgeFunctionSources(): { name: string; src: string }[] {
  if (!existsSync(FN_DIR)) return []
  return readdirSync(FN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => ({ name: d.name, file: join(FN_DIR, d.name, "index.ts") }))
    .filter((f) => existsSync(f.file))
    .map((f) => ({ name: f.name, src: readFileSync(f.file, "utf8") }))
}

describe("edge functions carry no hardcoded gate keys", () => {
  const fns = edgeFunctionSources()

  it("finds edge functions to check (guards against a silently-empty sweep)", () => {
    // A directory-driven check that matches nothing passes vacuously. Pin a
    // floor so a moved/renamed functions dir fails loudly instead.
    expect(fns.length).toBeGreaterThan(20)
  })

  it("has no rpc_pls_* literal anywhere", () => {
    const offenders = fns
      .filter((f) => /rpc_pls_[A-Za-z0-9_]+/.test(f.src))
      .map((f) => f.name)
    expect(offenders).toEqual([])
  })

  // Constants whose name contains KEY but which are NOT credentials. Each needs
  // a reason; anything not listed here is treated as a hardcoded secret.
  const NON_CREDENTIAL_KEY_CONSTANTS: Record<string, string> = {
    "backfill-topshot-base-parallel-probe: CURSOR_KEY":
      "event_cursor row id ('backfill-topshot-base-parallel-probe'), used as .eq('id', …) — a table key, not an auth key",
  }

  it("assigns no gate/key/secret/token constant from a string literal", () => {
    // Catches the shape regardless of the key's prefix — the next hardcoded
    // key will not be named rpc_pls_*.
    const offenders: string[] = []
    for (const { name, src } of fns) {
      for (const line of src.split(/\r?\n/)) {
        if (line.trim().startsWith("//")) continue
        const m = line.match(
          /\b(?:const|let|var)\s+([A-Za-z0-9_]*(?:GATE|KEY|SECRET|TOKEN)[A-Za-z0-9_]*)\s*=\s*"([^"]*)"/
        )
        // A short literal is a sentinel, not a credential.
        if (!m || m[2].length < 12) continue
        const id = `${name}: ${m[1]}`
        if (id in NON_CREDENTIAL_KEY_CONSTANTS) continue
        offenders.push(id)
      }
    }
    expect(offenders).toEqual([])
  })

  it("keeps the non-credential allowlist honest (no stale entries)", () => {
    // An allowlist entry whose constant no longer exists silently grants cover
    // to a future constant that happens to reuse the name.
    const present = new Set<string>()
    for (const { name, src } of fns) {
      for (const line of src.split(/\r?\n/)) {
        if (line.trim().startsWith("//")) continue
        const m = line.match(
          /\b(?:const|let|var)\s+([A-Za-z0-9_]*(?:GATE|KEY|SECRET|TOKEN)[A-Za-z0-9_]*)\s*=\s*"([^"]*)"/
        )
        if (m && m[2].length >= 12) present.add(`${name}: ${m[1]}`)
      }
    }
    for (const id of Object.keys(NON_CREDENTIAL_KEY_CONSTANTS)) {
      expect(present.has(id), `stale allowlist entry: ${id}`).toBe(true)
    }
  })

  it("every gate comparison fails CLOSED when the secret is unset", () => {
    // `Deno.env.get(X) ?? ""` plus a bare `param !== GATE` would ACCEPT a caller
    // sending a literal `?key=` (""==="" ). Each function reading a *_GATE_KEY
    // secret must also carry an explicit truthiness guard on that constant.
    const offenders: string[] = []
    for (const { name, src } of fns) {
      const decl = src.match(
        /const\s+([A-Za-z0-9_]+)\s*=\s*Deno\.env\.get\("([A-Za-z0-9_]*GATE_KEY)"\)\s*\?\?\s*""/
      )
      if (!decl) continue
      const constName = decl[1]
      const guarded =
        new RegExp(`!${constName}\\s*\\|\\|`).test(src) ||
        new RegExp(`!!${constName}\\s*&&`).test(src)
      if (!guarded) offenders.push(`${name}: ${constName} has no unset-guard`)
    }
    expect(offenders).toEqual([])
  })

  it("covers all eight de-hardcoded pack pipeline functions", () => {
    // Pins that the remediation actually reached every function the audit named.
    const expected = [
      "backfill-allday-pack-supply",
      "backfill-pack-opens-api",
      "backfill-topshot-pack-supply",
      "compute-golazos-pack-ev",
      "compute-pinnacle-pack-ev",
      "ingest-allday-pack-opens",
      "ingest-pinnacle-mints",
      "ingest-topshot-pack-opens-history",
    ]
    const withSecret = fns
      .filter((f) => /Deno\.env\.get\("[A-Za-z0-9_]*GATE_KEY"\)/.test(f.src))
      .map((f) => f.name)
    for (const name of expected) expect(withSecret).toContain(name)
  })
})
