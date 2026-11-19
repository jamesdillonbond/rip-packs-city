// __tests__/a-client-auth-read-always-handles-its-rejection.test.ts
//
// A browser `supabase.auth.getUser()` / `getSession()` consumed with `.then()`
// and no `.catch()` turns a failed auth read into an `unhandledrejection`.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-11-19) ────────────────────────────
// The client-error beacon recorded `Lock "lock:sb-…-auth-token" was released
// because another request stole it` from `getUser` as an unhandledrejection on
// /market, from two real iPhone sessions (11-08, 11-11). components/TopNav.tsx
// — rendered on every page — read the session with a bare `.then()`; so did
// app/share/[wallet]/SaveToCollectionCTA.tsx. Two siblings (WalletSearchBand,
// ShareHeroSignUp) already carried the catch: the shape had spread by copy.
//
// ── WHAT IT MATCHES, AND IS SILENT ABOUT ───────────────────────────────────
// Every `.auth.getUser()` / `.auth.getSession()` call that is NOT awaited, in
// app/, components/, hooks/ and lib/ (comments stripped). Each must have a
// `.catch(` in the same chained statement (the call's line plus every line
// after it that is blank, starts with `.`, or is indented deeper). An
// AWAITED call is out of scope: its rejection is the enclosing try/async's job.

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOTS = ["app", "components", "hooks", "lib"].map((d) => join(process.cwd(), d))

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

const toRel = (abs: string): string => abs.slice(process.cwd().length + 1).split("\\").join("/")

const AUTH_READ = /\.auth\s*\.\s*(getUser|getSession)\s*\(\s*\)/g

export function findUncaughtAuthReads(sources: Array<{ rel: string; src: string }>): string[] {
  const hits: string[] = []
  for (const { rel, src } of sources) {
    const code = stripComments(src)
    for (const m of code.matchAll(AUTH_READ)) {
      const at = m.index ?? 0
      // Awaited (directly, or via `await supabase\n  .auth…`)? Not this guard's case.
      const before = code.slice(Math.max(0, at - 160), at)
      const lastStmt = before.split(/[;{}]\s*\n?/).pop() ?? ""
      if (/\bawait\b/.test(lastStmt) || /\breturn\b/.test(lastStmt)) continue
      // The chained statement: the call's line, then every following line that
      // is blank, starts with `.`, or is indented deeper than the call's line
      // (a callback body). It ends at the first line back at the call's indent.
      const lines = code.split("\n")
      const startLine = code.slice(0, at).split("\n").length - 1
      const indent = (l: string) => l.length - l.trimStart().length
      const base = indent(lines[startLine])
      const chain = [lines[startLine]]
      for (let i = startLine + 1; i < lines.length; i++) {
        const l = lines[i]
        if (l.trim() === "" || l.trimStart().startsWith(".") || indent(l) > base) chain.push(l)
        else if (/^\s*[)}\]]/.test(l) && indent(l) === base) chain.push(l)
        else break
      }
      const stmt = chain.join("\n")
      if (!/\.then\s*\(/.test(stmt)) continue
      if (/\.catch\s*\(/.test(stmt)) continue
      const line = code.slice(0, at).split("\n").length
      hits.push(`${rel}:${line}: ${m[0]} .then() with no .catch()`)
    }
  }
  return hits
}

describe("a client auth read always handles its rejection", () => {
  const files = ROOTS.flatMap((r) => walk(r))
  const sources = files.map((f) => ({ rel: toRel(f), src: readFileSync(f, "utf8") }))
  const total = sources.reduce((n, s) => n + [...stripComments(s.src).matchAll(AUTH_READ)].length, 0)

  it("inspects the tree and finds auth reads (a guard that read nothing has not passed)", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(total).toBeGreaterThan(3)
  })

  it("no un-awaited getUser()/getSession() .then() chain lacks a .catch()", () => {
    expect(findUncaughtAuthReads(sources)).toEqual([])
  })

  it("flags the 11-19 shape and passes its fix (planted defect)", () => {
    const bad = `useEffect(() => {\n    supabase.auth.getUser().then(({ data }) => {\n      if (active) setSignedIn(!!data?.user)\n    })\n    const { data: sub } = x\n  }, [])\n`
    const good = `useEffect(() => {\n    supabase.auth\n      .getUser()\n      .then(({ data }) => setSignedIn(!!data?.user))\n      .catch(() => {})\n    const { data: sub } = x\n  }, [])\n`
    const awaited = `async function f() {\n  const { data } = await supabase.auth.getUser()\n}\n`
    expect(findUncaughtAuthReads([{ rel: "bad.tsx", src: bad }])).toHaveLength(1)
    expect(findUncaughtAuthReads([{ rel: "good.tsx", src: good }])).toEqual([])
    expect(findUncaughtAuthReads([{ rel: "awaited.ts", src: awaited }])).toEqual([])
  })
})
