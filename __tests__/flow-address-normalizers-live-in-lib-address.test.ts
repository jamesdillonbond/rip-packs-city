import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN AT ZERO: a Flow-address normaliser is DEFINED in lib/address.ts and nowhere
// else under app/, components/, lib/ or workers/. A module may re-export or alias
// one (`export const normalizeAddress = normalizeFlowEventAddress`) for its
// importers; it may not carry its own body.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// 2026-10-15/16: seven byte-identical `normalizeAddress` copies in the Flow
// indexers, plus four `normalizeFlowAddress`-shaped copies in lib/. Two of those
// four were BOTH exported as `normalizeFlowAddress` with OPPOSITE rules for an
// unprefixed hex string (lib/auth/flow-signature.ts accepted it,
// lib/wallet-capability.ts rejected it), and one admin backfill folded-and-prefixed
// without padding, writing event addresses short. A copy drifts the moment it is
// made; the only stable count is one.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ──────
//  1. scripts/ — standalone by convention (no lib/ imports); one byte-identical
//     copy lives in scripts/resolve-allday-buyers.ts.
//  2. supabase/functions — Deno, cannot import lib/; carries its own copies.
//  3. Differently-named helpers with DIFFERENT semantics (`normalizeAddr` in
//     /api/mcp/keys and /api/profile/verify-challenge/* accepts any 0x string,
//     EVM included). Not the same function; moving them would narrow a chain.
//  4. Inline normalisation with no named helper.

const ROOTS = ["app", "components", "lib", "workers"]
const CANONICAL = "lib/address.ts"
const NAMES = ["normalizeFlowAddress", "normalizeFlowAddressStrict", "normalizeFlowEventAddress", "normalizeAddress"]
const NAME = NAMES.join("|")
// A function declaration, or a const/let bound to anything OTHER than one of the
// canonical functions (an arrow body, a function expression, a fresh wrapper).
const DEFINITION = new RegExp(
  // The lookahead sits directly after `=` and swallows its own whitespace: put a
  // `\s*` before it and the engine backtracks one space so every alias "matches".
  `\\bfunction\\s+(${NAME})\\b|\\b(?:const|let)\\s+(${NAME})\\s*=(?!\\s*(?:${NAME})\\b[ \\t]*(?:;|\\r?\\n|$))`,
  "g",
)

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p)
  }
}

function files(): string[] {
  const out: string[] = []
  for (const r of ROOTS) {
    try { walk(r, out) } catch { /* root absent */ }
  }
  return out.map((p) => p.replace(/\\/g, "/"))
}

function definitionsIn(src: string): string[] {
  const hits: string[] = []
  for (const m of stripComments(src).matchAll(DEFINITION)) hits.push(m[1] ?? m[2])
  return hits
}

describe("Flow-address normalisers are defined once, in lib/address.ts", () => {
  const all = files()

  it("walks a real tree (not vacuous)", () => {
    expect(all.length).toBeGreaterThan(500)
    expect(all).toContain(CANONICAL)
  })

  it("the canonical file defines every name it exports", () => {
    const src = readFileSync(CANONICAL, "utf8")
    for (const n of ["normalizeFlowAddress", "normalizeFlowAddressStrict", "normalizeFlowEventAddress", "normalizeAddress"]) {
      expect(definitionsIn(src)).toContain(n)
    }
  })

  it("no other file carries its own body for one of them", () => {
    const offenders: string[] = []
    for (const f of all) {
      if (f === CANONICAL) continue
      const hits = definitionsIn(readFileSync(f, "utf8"))
      for (const h of hits) offenders.push(`${f}: ${h}`)
    }
    expect(offenders).toEqual([])
  })

  it("the detector sees a planted copy and ignores an alias (proved, not read)", () => {
    expect(definitionsIn("function normalizeAddress(raw: string) { return raw }")).toEqual(["normalizeAddress"])
    expect(definitionsIn("export const normalizeFlowAddress = (s: unknown) => null")).toEqual(["normalizeFlowAddress"])
    expect(definitionsIn("const normalizeAddress = function (r: string) { return r }")).toEqual(["normalizeAddress"])
    expect(definitionsIn("export const normalizeAddress = normalizeFlowEventAddress\n")).toEqual([])
    expect(definitionsIn("const normalizeWallet = normalizeFlowAddressStrict\n")).toEqual([])
    expect(definitionsIn("// function normalizeAddress(raw) {}\n")).toEqual([])
  })
})
