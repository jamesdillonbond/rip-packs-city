import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

// Security audit 2026-10-25, register R138(f): every Cloudflare worker checks
// its shared secret with a constant-time compare (a local `safeEqual`), never
// `===` / `!==` against the env secret. Timing a compare through Cloudflare's
// network is impractical, so this is hygiene — but a ban at zero keeps a new
// worker from copying the old shape back in.

const WORKERS = path.resolve(__dirname, "..", "workers")
const entries = readdirSync(WORKERS)
  .map((d) => ["index.ts", "index.js"].map((f) => path.join(WORKERS, d, f)).find(existsSync))
  .filter((f): f is string => !!f)

// `x === env.SOME_SECRET`, `x !== \`Bearer ${env.SOME_TOKEN}\``, `auth !== expected`
const BARE = /(!==|===)\s*(env\.[A-Z0-9_]*(SECRET|TOKEN)\b|`Bearer \$\{env\.[A-Z0-9_]*\}`|expected\b)/

describe("workers compare secrets in constant time", () => {
  it("inspects every worker entry point (not vacuous)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(16)
  })

  it("no worker compares a secret with === / !==", () => {
    const bad = entries.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [l, i + 1] as const)
        .filter(([l]) => !l.trim().startsWith("//") && BARE.test(l))
        .map(([l, n]) => `${path.relative(WORKERS, f)}:${n}: ${l.trim()}`),
    )
    expect(bad).toEqual([])
  })

  it("every worker that reads a secret defines safeEqual", () => {
    const missing = entries.filter((f) => {
      const s = readFileSync(f, "utf8")
      return /env\.[A-Z0-9_]*(SECRET|TOKEN)\b/.test(s) && !/function safeEqual\(/.test(s)
    })
    expect(missing.map((f) => path.relative(WORKERS, f))).toEqual([])
  })

  it("the pattern fires on the shapes it bans (planted)", () => {
    expect(BARE.test("if (!auth || auth !== env.PROXY_SECRET) {")).toBe(true)
    expect(BARE.test("auth !== `Bearer ${env.INGEST_SECRET_TOKEN}`")).toBe(true)
    expect(BARE.test("if (!env.X || auth !== expected) {")).toBe(true)
    expect(BARE.test("if (!safeEqual(auth, env.PROXY_SECRET)) {")).toBe(false)
  })
})
