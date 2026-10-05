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

// ⚠ THE EXCEPTIONS, all Flow Wallet only (pinned below):
//   * the giveaway ADMIN connects their OWN Flow Wallet on /admin/giveaways to
//     approve a delivery transaction (Trevor, 2026-09-29: "Yes do that");
//   * a giveaway WINNER connects Flow Wallet on /giveaways/<slug> to say where
//     their pack goes — CONNECT ONLY, it never signs (Trevor, 2026-10-03: "Let's
//     plan on using Flow Wallet to claim instead of Dapper");
//   * the ADMIN-ONLY two-signer swap test on /admin/swap-test: Trevor's own two
//     Flow Wallets each sign one swap transaction (Trevor, 2026-10-03: "Do it all").
// The wallet picker itself lives in exactly one module; each caller is imported
// by exactly one page. Everywhere else, still no wallet sign-in.
const CONNECT_MODULE = "lib/giveaways/flow-wallet-connect.ts"
const CONNECT_IMPORTERS = ["lib/giveaways/admin-wallet.ts", "lib/giveaways/claim-wallet.ts", "lib/swap-test/swap-wallet.ts"]
const ADMIN_WALLET_IMPORTER = "app/admin/giveaways/AdminGiveawaysClient.tsx"
const CLAIM_WALLET_IMPORTER = "app/giveaways/[slug]/GiveawayClient.tsx"
const SWAP_WALLET_IMPORTER = "app/admin/swap-test/SwapTestClient.tsx"
const notTheException = (f: { path: string }) => f.path !== CONNECT_MODULE
/** Static `from "x"` or dynamic `import("x")` of a module specifier. */
const imports = (src: string, spec: string) => new RegExp(`(from\\s+|import\\(\\s*)["']${spec.replace(/[/.]/g, (c) => "\\" + c)}["']`).test(src)

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
    const offenders = FILES.filter(notTheException)
      .filter((f) => /\bfcl\.(un)?authenticate\s*\(/.test(f.src))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("nothing configures FCL wallet discovery", () => {
    // `discovery.wallet` / `discovery.authn.*` are the keys that make FCL pop a
    // wallet-connect dialog. lib/chains/flow/flow.ts sets CHAIN config only.
    const offenders = FILES.filter(notTheException)
      .filter((f) => /["']discovery\.(wallet|authn)/.test(f.src))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it("the wallet picker is exactly one module, used only by the admin and claim wallet modules", () => {
    const mod = FILES.find((f) => f.path === CONNECT_MODULE)
    // positive control: the exception is real and still does what it is excused for
    expect(mod, `${CONNECT_MODULE} is missing — delete this exception instead`).toBeTruthy()
    expect(mod!.src).toMatch(/\bfcl\.authenticate\s*\(/)
    const importers = FILES.filter((f) => imports(f.src, "@/lib/giveaways/flow-wallet-connect")).map((f) => f.path).sort()
    expect(importers).toEqual(CONNECT_IMPORTERS)
  })

  it("the admin wallet module is imported only by the admin giveaway console", () => {
    const importers = FILES.filter((f) => imports(f.src, "@/lib/giveaways/admin-wallet")).map((f) => f.path).sort()
    // + the admin-only swap test, which reuses its stall hint and seal-read helpers (2026-10-04)
    expect(importers).toEqual([ADMIN_WALLET_IMPORTER, "lib/swap-test/swap-wallet.ts"].sort())
    // and the importer is an admin page (token-gated), never a user surface
    expect(ADMIN_WALLET_IMPORTER.startsWith("app/admin/")).toBe(true)
  })

  it("the swap-test wallet module is imported only by the admin swap-test console", () => {
    // Trevor, 2026-10-03 ("Do it all"): an ADMIN-ONLY two-signer swap test on his own
    // wallets. Not a user surface; never widen it without his say-so.
    const importers = FILES.filter((f) => imports(f.src, "@/lib/swap-test/swap-wallet")).map((f) => f.path)
    expect(importers).toEqual([SWAP_WALLET_IMPORTER])
    expect(SWAP_WALLET_IMPORTER.startsWith("app/admin/")).toBe(true)
  })

  it("the claim wallet module is imported only by the giveaway claim page, and never signs", () => {
    const importers = FILES.filter((f) => imports(f.src, "@/lib/giveaways/claim-wallet")).map((f) => f.path)
    expect(importers).toEqual([CLAIM_WALLET_IMPORTER])
    const mod = FILES.find((f) => f.path === "lib/giveaways/claim-wallet.ts")!
    // connect only: no transaction, no signature, no Cadence, not even an FCL import of its own
    expect(mod.src).not.toMatch(/\bmutate\b|\bauthorization\b|signUserMessage|\bcadence\b|@onflow\/fcl/)
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
