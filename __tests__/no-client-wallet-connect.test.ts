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
//     Flow Wallets each sign one swap transaction (Trevor, 2026-10-03: "Do it all");
//   * a TRADE ROOM user on /trades/<code> connects Flow Wallet WITH the account
//     proof (so the server knows the wallet is theirs) and, once both sides have
//     accepted, signs the same two-authorizer swap the admin test proves
//     (Trevor, 2026-10-31: "continue building out our trade features" →
//     "User-to-user trade room"). The signing step stays behind
//     RPC_TRADE_ROOM_EXECUTE until that live test has sealed.
// The wallet picker itself lives in exactly one module; each caller is imported
// by exactly one page. Everywhere else, still no wallet sign-in.
const CONNECT_MODULE = "lib/giveaways/flow-wallet-connect.ts"
const CONNECT_IMPORTERS = ["lib/giveaways/admin-wallet.ts", "lib/giveaways/claim-wallet.ts", "lib/swap-test/swap-wallet.ts", "lib/trade-room/trade-wallet.ts"]
const ADMIN_WALLET_IMPORTER = "app/admin/giveaways/AdminGiveawaysClient.tsx"
const CLAIM_WALLET_IMPORTER = "app/giveaways/[slug]/GiveawayClient.tsx"
const SWAP_WALLET_IMPORTER = "app/admin/swap-test/SwapTestClient.tsx"
const TRADE_WALLET_MODULE = "lib/trade-room/trade-wallet.ts"
const TRADE_WALLET_IMPORTER = "app/trades/[code]/TradeRoomClient.tsx"
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

  it("the swap-test wallet module is imported only by the admin swap-test console and the trade-room wallet module", () => {
    // Trevor, 2026-10-03 ("Do it all"): an ADMIN-ONLY two-signer swap test on his own
    // wallets. 2026-10-31: the user trade room reuses its sign/co-sign functions
    // through lib/trade-room/trade-wallet.ts, so the wallets sign exactly the
    // transaction the admin test proves. Nothing else.
    const importers = FILES.filter((f) => imports(f.src, "@/lib/swap-test/swap-wallet")).map((f) => f.path).sort()
    expect(importers).toEqual([SWAP_WALLET_IMPORTER, TRADE_WALLET_MODULE].sort())
    expect(SWAP_WALLET_IMPORTER.startsWith("app/admin/")).toBe(true)
  })

  it("the trade-room wallet module is imported only by the trade room page, and its signing step is gated", () => {
    const importers = FILES.filter((f) => imports(f.src, "@/lib/trade-room/trade-wallet")).map((f) => f.path)
    expect(importers).toEqual([TRADE_WALLET_IMPORTER])
    // the page asks a wallet to sign only through the room route's relay_post, which
    // refuses until RPC_TRADE_ROOM_EXECUTE is set (lib/trade-room/execute.ts)
    const route = FILES.find((f) => f.path === "app/api/trade-room/[code]/route.ts")
    expect(route, "the trade-room route is missing").toBeTruthy()
    expect(route!.src).toMatch(/case "relay_post": \{\s*if \(!executionOpen\(\)\) throw/)
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
