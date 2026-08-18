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

  // Functions that express the gate through a `gateKeyOk()` helper (the dual-accept
  // shape) get their guard EXECUTED below rather than pattern-matched. Everything
  // else still gets the syntactic check.
  //
  // ⚠ This used to be syntax-only — it searched for `!GATE ||` / `!!GATE &&`. That is a
  // proxy for the real invariant, and it broke the moment the identical guard moved
  // inside a helper: the behaviour was unchanged and correct, the spelling was not.
  // A syntactic guard fails on a refactor and, worse, would PASS a rewrite that kept
  // the spelling while breaking the logic. The invariant is behavioural, so assert it
  // behaviourally.
  function extractGateBlock(src: string): string | null {
    const start = src.search(/const\s+[A-Za-z0-9_]+\s*=\s*Deno\.env\.get\("[A-Za-z0-9_]*GATE_KEY"\)/)
    if (start < 0) return null
    const fnAt = src.indexOf("function gateKeyOk", start)
    if (fnAt < 0) return null
    const end = src.indexOf("\n}", fnAt)
    if (end < 0) return null
    return src
      .slice(start, end + 2)
      .replace(/:\s*string\s*\|\s*null/g, "")
      .replace(/:\s*boolean/g, "")
  }

  it("every gate comparison fails CLOSED when the secret is unset", () => {
    // `Deno.env.get(X) ?? ""` plus a bare `param !== GATE` would ACCEPT a caller
    // sending a literal `?key=` (""==="" ). Each function reading a *_GATE_KEY
    // secret must reject every candidate key while the secret is unset.
    const offenders: string[] = []
    let executed = 0

    for (const { name, src } of fns) {
      const decl = src.match(
        /const\s+([A-Za-z0-9_]+)\s*=\s*Deno\.env\.get\("([A-Za-z0-9_]*GATE_KEY)"\)\s*\?\?\s*""/
      )
      if (!decl) continue
      const [, constName, envName] = decl

      const block = extractGateBlock(src)
      if (block) {
        // Execute the REAL guard under every combination of set/unset secrets.
        const gateKeyOk = new Function("Deno", `${block}\nreturn gateKeyOk`)({
          env: { get: (k: string) => (k === envName ? "NEWKEY" : undefined) },
        }) as (k: string | null) => boolean
        const closed = new Function("Deno", `${block}\nreturn gateKeyOk`)({
          env: { get: () => undefined },
        }) as (k: string | null) => boolean

        // Unset ⇒ nothing is accepted, including the empty string and the real key.
        for (const probe of [null, "", "NEWKEY", "anything"]) {
          if (closed(probe)) offenders.push(`${name}: ${constName} ACCEPTS ${JSON.stringify(probe)} while unset`)
        }
        // Set ⇒ the correct key works and a wrong/empty one does not (proves the
        // unset case above is a real guard, not a function that rejects everything).
        if (!gateKeyOk("NEWKEY")) offenders.push(`${name}: ${constName} rejects the correct key when set`)
        for (const probe of [null, "", "wrong"]) {
          if (gateKeyOk(probe)) offenders.push(`${name}: ${constName} ACCEPTS ${JSON.stringify(probe)} when set`)
        }
        executed++
        continue
      }

      // No helper — fall back to the syntactic check so a new function written in
      // the original inline style is still covered.
      const guarded =
        new RegExp(`!${constName}\\s*\\|\\|`).test(src) ||
        new RegExp(`!!${constName}\\s*&&`).test(src) ||
        new RegExp(`${constName}\\s*!==\\s*""`).test(src)
      if (!guarded) offenders.push(`${name}: ${constName} has no unset-guard`)
    }

    expect(offenders).toEqual([])
    // Guards the guard: if extraction silently stopped matching, every function
    // would fall through to the weaker syntactic path and this test would quietly
    // stop executing anything.
    //
    // 8 -> 9 on 2026-08-18: resolve-allday-rip-dist-api had NO committed source when
    // this count was set -- it was one of ~30 deployed edge functions absent from the
    // repo, so its hardcoded `const GATE` was outside this sweep's reach entirely.
    // That is NOT a false-green: a literal absent from a public repo does not leak via
    // the repo. What it did leave behind is a DEPLOYED function that could not be
    // rotated by the documented procedure -- there was no secret to paste a new key
    // into -- which is exactly how repointing cron jobid 26 produced a self-inflicted
    // 403 with no way to fix it. Committing its de-literalised v6 source is what raised
    // this count. Raise it again ONLY alongside a function that genuinely reads a
    // *_GATE_KEY secret; a DROP means extraction broke.
    expect(executed).toBe(9)
  })

  it("accepts the outgoing key ONLY while its own _OLD secret is set", () => {
    // The dual-accept window exists so a key rotation has no broken intermediate
    // state (cron can be repointed job-by-job). It must close by itself when the
    // _OLD secret is deleted — that deletion is the last step of a rotation and
    // needs no redeploy, so nothing else enforces it.
    const offenders: string[] = []
    for (const { name, src } of fns) {
      const block = extractGateBlock(src)
      if (!block) continue
      const envName = src.match(/Deno\.env\.get\("([A-Za-z0-9_]*GATE_KEY)"\)/)?.[1]
      if (!envName) continue

      const build = (env: Record<string, string>) =>
        new Function("Deno", `${block}\nreturn gateKeyOk`)({
          env: { get: (k: string) => env[k] },
        }) as (k: string | null) => boolean

      const both = build({ [envName]: "NEWKEY", [`${envName}_OLD`]: "OLDKEY" })
      if (!both("NEWKEY") || !both("OLDKEY")) offenders.push(`${name}: dual-accept window does not accept both keys`)

      const rotated = build({ [envName]: "NEWKEY" })
      if (rotated("OLDKEY")) offenders.push(`${name}: still accepts the outgoing key after _OLD is deleted`)
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
