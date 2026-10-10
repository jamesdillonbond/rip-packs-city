import { describe, it, expect, afterEach } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { bearerMatches } from "@/lib/auth/bearer-secret"

// A secret compare written as `auth !== \`Bearer ${process.env.X}\`` FAILS OPEN:
// with X unset, the literal header "Bearer undefined" passes. The OR form opens
// if EITHER secret is unset. 27 routes carried it on 2026-10-09 (latent: every
// var is set in production). They now use lib/auth/bearer-secret.ts, and this
// ratchet bans the bare compare in app/ at ZERO.

describe("bearerMatches", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it("matches the configured secret", () => {
    process.env.TEST_SECRET_A = "s3cret"
    expect(bearerMatches("Bearer s3cret", "TEST_SECRET_A")).toBe(true)
    expect(bearerMatches("Bearer nope", "TEST_SECRET_A")).toBe(false)
  })

  it("FAILS CLOSED when the secret is unset or empty — 'Bearer undefined' and 'Bearer ' never pass", () => {
    delete process.env.TEST_SECRET_A
    expect(bearerMatches("Bearer undefined", "TEST_SECRET_A")).toBe(false)
    process.env.TEST_SECRET_A = ""
    expect(bearerMatches("Bearer ", "TEST_SECRET_A")).toBe(false)
    expect(bearerMatches("Bearer undefined", "TEST_SECRET_A")).toBe(false)
  })

  it("with two names, an unset one cannot open the route while the other still works", () => {
    delete process.env.TEST_SECRET_A
    process.env.TEST_SECRET_B = "b"
    expect(bearerMatches("Bearer undefined", "TEST_SECRET_A", "TEST_SECRET_B")).toBe(false)
    expect(bearerMatches("Bearer b", "TEST_SECRET_A", "TEST_SECRET_B")).toBe(true)
  })

  it("a missing header never matches", () => {
    process.env.TEST_SECRET_A = "x"
    expect(bearerMatches(null, "TEST_SECRET_A")).toBe(false)
    expect(bearerMatches(undefined, "TEST_SECRET_A")).toBe(false)
    expect(bearerMatches("", "TEST_SECRET_A")).toBe(false)
  })
})

// The bare compare, on a line that does not first test that same env var.
const BARE = /[=!]==\s*`Bearer \$\{process\.env\.(\w+)\}`/
export function bareSecretCompares(src: string): string[] {
  const hits: string[] = []
  for (const line of src.split("\n")) {
    const m = line.match(BARE)
    if (!m) continue
    const name = m[1]
    const guarded = new RegExp(`process\\.env\\.${name}\\s*&&|!process\\.env\\.${name}\\s*\\|\\|`).test(line)
    if (!guarded) hits.push(line.trim())
  }
  return hits
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe("no bare `Bearer ${process.env.X}` compare in app/", () => {
  const files = walk("app")
  it("inspects a real population", () => {
    expect(files.length).toBeGreaterThan(500)
  })
  it("is at zero", () => {
    const offenders = files.flatMap((f) => bareSecretCompares(readFileSync(f, "utf8")).map((l) => `${f}: ${l}`))
    expect(offenders).toEqual([])
  })
  it("is not vacuous: the detector flags both shapes and spares the guarded one", () => {
    expect(bareSecretCompares("if (auth !== `Bearer ${process.env.X}`) {")).toHaveLength(1)
    expect(bareSecretCompares("    auth === `Bearer ${process.env.CRON_SECRET}`")).toHaveLength(1)
    expect(bareSecretCompares("if (process.env.X && auth === `Bearer ${process.env.X}`) return true")).toHaveLength(0)
    expect(bareSecretCompares("if (!process.env.X || auth !== `Bearer ${process.env.X}`) {")).toHaveLength(0)
  })
})
