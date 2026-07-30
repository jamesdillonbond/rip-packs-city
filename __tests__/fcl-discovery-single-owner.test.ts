import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

// Pins the 2026-07-29 fix: FCL's `discovery.wallet` is a GLOBAL singleton, and
// exactly ONE module may write it — lib/chains/flow/fcl-config.ts.
//
// The defect this guards against: lib/chains/flow/flow.ts also wrote
// `discovery.wallet` (Dapper-restricted) from an auto-init IMPORT SIDE EFFECT, while
// fcl-config.ts wrote self-custody discovery behind its own init guard. Neither guard
// could see the other, so both endpoints shipped to /dashboard and which one won was
// import-order dependent.
//
// The defect is not either VALUE — it is that two places can set it. So this test
// asserts ownership, not endpoints.

const ROOT = join(__dirname, "..")
const SCAN_DIRS = ["lib", "app", "components", "workers"]
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs)$/
const SKIP_DIR = new Set(["node_modules", ".next", "dist", "build", "__tests__", "coverage"])

// The one legitimate owner.
const OWNER = join("lib", "chains", "flow", "fcl-config.ts")

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (CODE_EXT.test(name)) out.push(full)
  }
  return out
}

function sourceFiles(): string[] {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files)
  return files
}

/** Files that WRITE a `discovery.*` FCL config key (not merely mention it). */
function discoveryWriters(): { wallet: string[]; any: string[] } {
  const wallet: string[] = []
  const any: string[] = []
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8")
    // Strip line comments so the explanatory notes in flow.ts don't count as writes.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    const rel = relative(ROOT, file).split(sep).join(sep)

    // A write looks like `.put("discovery.wallet", …)` or a `'discovery.wallet':` key
    // in an object handed to fcl.config({...}).
    if (/["']discovery\.wallet["']\s*[,:)]/.test(code)) wallet.push(rel)
    if (/["']discovery\.[a-z.]+["']\s*[,:)]/.test(code)) any.push(rel)
  }
  return { wallet, any }
}

describe("FCL discovery.wallet — single owner", () => {
  it("is written by exactly one module: lib/chains/flow/fcl-config.ts", () => {
    const { wallet } = discoveryWriters()
    expect(wallet).toEqual([OWNER])
  })

  it("no module other than the owner writes ANY discovery.* key", () => {
    const { any } = discoveryWriters()
    expect([...new Set(any)]).toEqual([OWNER])
  })

  it("lib/chains/flow/flow.ts sets no discovery key — its auto-init runs on import", () => {
    const src = readFileSync(join(ROOT, "lib", "chains", "flow", "flow.ts"), "utf8")
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")

    // The import side effect is intentional and load-bearing (server routes import
    // the default export and call fcl.query() without calling initFcl()) — it is
    // only safe BECAUSE it no longer touches wallet discovery.
    expect(code).toMatch(/^initFcl\(\)/m)
    expect(code).not.toMatch(/discovery\./)
    // The old Dapper-restricted endpoint must not reappear in the chain config.
    expect(code).not.toContain("accounts.meetdapper.com")
  })
})
