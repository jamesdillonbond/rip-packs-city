import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

// THE invariant Trevor asked for on 2026-08-08: RPC offers NO wallet sign-in on
// any surface. Users cannot sign into Dapper Wallet without Dapper developer
// approval we do not have, so RPC asks only for a public identifier (a wallet
// address or a username) and reads it view-only.
//
// This replaces the deleted fcl-discovery-single-owner test, which pinned "there
// is exactly ONE owner of wallet discovery". That invariant stopped existing
// when the last discovery config was removed; this is the stronger successor:
// there are ZERO.
//
// It has to be a source scan, not a type check — reintroducing fcl.authenticate()
// in a client component compiles perfectly. That is exactly how the regression
// would have shipped silently.

const ROOTS = ["app", "components", "lib"]
const CODE_EXT = /\.(ts|tsx)$/
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (CODE_EXT.test(entry)) out.push(full)
  }
  return out
}

const FILES = ROOTS.flatMap((r) => walk(r)).map((path) => ({
  path: path.replace(/\\/g, "/"),
  src: readFileSync(path, "utf8"),
}))

const clientFiles = FILES.filter((f) => /^\s*["']use client["']/m.test(f.src))

describe("no wallet sign-in anywhere (Trevor, 2026-08-08)", () => {
  it("has client components to scan (guards against the scan silently matching nothing)", () => {
    // A positive control: if the walker broke, every assertion below would pass
    // vacuously and the invariant would be unguarded while reading green.
    expect(clientFiles.length).toBeGreaterThan(50)
  })

  it("no client component imports @onflow/fcl", () => {
    const offenders = clientFiles
      .filter((f) => /from\s+["']@onflow\/fcl["']|require\(["']@onflow\/fcl["']\)/.test(f.src))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("nothing in the tree calls fcl.authenticate() or fcl.unauthenticate()", () => {
    const offenders = FILES.filter((f) => /\bfcl\.(un)?authenticate\s*\(/.test(f.src)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("nothing configures FCL wallet discovery", () => {
    // `discovery.wallet` / `discovery.authn.*` are the keys that make FCL pop a
    // wallet-connect dialog. lib/chains/flow/flow.ts sets CHAIN config only.
    const offenders = FILES.filter((f) => /["']discovery\.(wallet|authn)/.test(f.src)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("no rendered copy tells the user to connect a wallet", () => {
    // The code invariant held while the COPY kept promising a connect surface —
    // four strings survived the 2026-08-08 removal and were still telling users
    // to "connect a wallet" / "connect yours" on live pages (deep-audit D35).
    // A product with no connect button must not ask for one anywhere.
    const BANNED = [
      /connect a wallet/i,
      /connect your wallet/i,
      /\(or connect yours\)/i,
      /connect or search a wallet/i,
      /sign in with dapper/i,
    ]
    // Scoped to rendered UI (.tsx). Deliberately NOT the concierge system prompt
    // (app/api/support-chat/route.ts): that file is where the RULE lives, and it
    // states the banned phrases as negations — "RPC never asks you to connect or
    // sign a wallet", "Never tell a user to look for a 'Sign in with Dapper' /
    // 'connect wallet' button — none exists". Matching those would force the rule
    // to be deleted to make the guard pass, which is exactly backwards.
    const offenders: string[] = []
    for (const f of FILES) {
      if (!f.path.endsWith(".tsx")) continue
      for (const line of f.src.split(/\r?\n/)) {
        // Comments explain the invariant and legitimately name the banned copy.
        const t = line.trim()
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue
        if (BANNED.some((re) => re.test(line))) offenders.push(f.path)
      }
    }
    expect([...new Set(offenders)]).toEqual([])
  })

  it("the removed FCL sign-in routes and modules are gone", () => {
    const gone = [
      "app/api/auth/fcl-verify/route.ts",
      "app/api/auth/fcl-nonce/route.ts",
      "app/api/profile/verify-link/route.ts",
      "lib/chains/flow/fcl-config.ts",
      "lib/hooks/useFlowUser.ts",
      "components/SignInWithDapper.tsx",
      "components/auth/ConnectButton.tsx",
    ]
    const stillPresent = gone.filter((p) => FILES.some((f) => f.path === p))
    expect(stillPresent).toEqual([])
  })
})
