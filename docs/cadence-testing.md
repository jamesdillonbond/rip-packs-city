# Cadence Testing — purchase-moment regression net

## Scope

This harness is a **type-check-only regression net** for the purchase-moment Cadence transaction. It does not execute the transaction on an emulator, does not simulate a Top Shot listing, and does not exercise the Dapper meta-transaction co-signer. Behavioral testing belongs in a future session that has access to a Dapper testnet co-signer; we do not have that today.

> **Canonical source (Phase D, 2026-05-30):** the production transaction now lives in `lib/chains/flow/cadence/purchase-moment.ts`. `lib/cadence/purchase-moment.ts` is a re-export shim with no literal. `scripts/extract-cadence.mjs` resolves whichever path actually holds the `PURCHASE_MOMENT_CADENCE` template literal (canonical first, old shim path as a fallback), so the harness keeps working across the reorg.

What the harness does:

- Extracts the Cadence transaction string from the canonical `purchase-moment.ts` into a `.cdc` fixture, rewriting Flow mainnet address-form imports to string-form so `flow cadence lint` can resolve them.
- Resolves those imports against committed stubs (for `DapperUtilityCoin` and `TopShot`) and against `flow dependencies install`-cached mainnet sources (for `NFTStorefrontV2`, `FungibleToken`, `NonFungibleToken`, `MetadataViews`, `ViewResolver`).
- Runs the Cadence linter / type-checker against the fixture and fails the build if `purchase-moment.ts` fails to type-check.

The harness is **GREEN and BLOCKING as of 2026-05-30** — the C1 and C2 audit findings from `docs/audits/purchase-moment-2026-05.md` are fixed in the canonical `purchase-moment.ts` (`FungibleToken` is imported; `self.listing` is borrowed before its price is read), so `npm run test:cadence` exits 0 (0 errors, 2 allowed string-template warnings). The H1 and H2 runtime findings were subsequently fixed too (commit `e5c36a8`), but those are not type-check-detectable and the harness never covered them (see "Flipping the harness GREEN" below). The `cadence-lint` job in `.github/workflows/ci.yml` no longer carries `continue-on-error: true` — it is a true blocking regression gate: any future type error in the production transaction fails the build. The "Interpreting the current RED output" section below is **historical** — retained to document what the original C1/C2 failure looked like.

## Prerequisites

- **Flow CLI** must be installed and on `PATH`. Verify with `flow version`. The harness was developed against `v2.17.0`. Install on Windows (Git Bash):

  ```bash
  iex "& { $(irm 'https://raw.githubusercontent.com/onflow/flow-cli/master/install.ps1') }"
  ```

  On macOS / Linux:

  ```bash
  sh -ci "$(curl -fsSL https://raw.githubusercontent.com/onflow/flow-cli/master/install.sh)"
  ```

- **Mainnet contract sources** must be cached locally. After cloning the repo, run once:

  ```bash
  flow dependencies install -f tests/cadence/flow.test.json -y
  ```

  This populates the gitignored `imports/` directory with vendored copies of `NFTStorefrontV2`, `FungibleToken`, `NonFungibleToken`, `MetadataViews`, `ViewResolver`, and `Burner` from Flow mainnet. The script is idempotent — subsequent runs are no-ops if the cached sources are up to date.

The `flow.test.json` config is committed to the repo and contains no secrets. The hot-wallet `flow.json` (which holds the `0x3aa11c84d776838f` private key for production scripts and tx submission) is gitignored and is not touched by this harness.

## Layout

```
lib/chains/flow/cadence/             Production Cadence (canonical, Phase D) —
  purchase-moment.ts                 DO NOT modify in this harness. Edits land
                                     in dedicated audit-fix sessions.
                                     (lib/cadence/purchase-moment.ts is a
                                     re-export shim of this file.)

scripts/extract-cadence.mjs          Reads the canonical purchase-moment.ts
                                     (resolving the shim/canonical path),
                                     extracts the PURCHASE_MOMENT_CADENCE
                                     template literal, rewrites
                                     `import X from 0x...` to `import "X"`,
                                     and writes the result to fixtures/.
                                     Idempotent.

tests/cadence/flow.test.json         Committed, no secrets. Wires string-
                                     form imports to stub paths and
                                     dependency declarations. Used only by
                                     `flow cadence lint`.

tests/cadence/stubs/                 Type-shape stubs (committed).
  DapperUtilityCoin.cdc              FungibleToken-conforming Vault stub.
                                     Real DUC is closed-source.
  TopShot.cdc                        Empty stub. Production transaction
                                     never references TopShot.* directly.

tests/cadence/fixtures/              Auto-generated, gitignored.
  purchase-moment.cdc                Built by extract-cadence.mjs from
                                     the production .ts on every test run.

docs/cadence-testing.md              This file.
```

## Running the harness

```bash
npm run test:cadence
```

Equivalent to:

```bash
node scripts/extract-cadence.mjs
flow cadence lint -f tests/cadence/flow.test.json tests/cadence/fixtures/purchase-moment.cdc
```

Exit codes:

- **0** — no semantic errors (warnings are allowed). The harness is GREEN; `purchase-moment.ts` type-checks cleanly.
- **1** — at least one `semantic-error` line in the lint output. The harness is RED; either the audit findings are still unfixed or a regression has been introduced.

## Interpreting the current RED output (HISTORICAL — C1/C2 are fixed)

> This section describes the original RED state before the C1/C2 fixes landed. The harness is GREEN now; this is kept only as a record of what the failure looked like.

```
fixtures/purchase-moment.cdc:30:21: semantic-error: cannot access uninitialized field: `listing`
fixtures/purchase-moment.cdc:37:45: semantic-error: cannot find type in this scope: `FungibleToken`
fixtures/purchase-moment.cdc:41:25: semantic-error: access denied: cannot access `withdraw` because function requires `Withdraw` authorization, but reference only has `FungibleToken` authorization
```

| Line | Audit ID | Maps to fix |
|------|----------|-------------|
| 30:21 | C1 | Initialize `self.listing` before reading `getDetails().salePrice`. The price-validation block must move below the `borrowListing` block. |
| 37:45 | C2 | Add `import FungibleToken from 0xf233dcee88fe0abe` at the top of the transaction. |
| 41:25 | (cascade of C2) | Disappears automatically once C2 is fixed — once `FungibleToken` resolves as a contract, `auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault` parses correctly and the entitlement-mismatch error goes away. |

Line numbers refer to `tests/cadence/fixtures/purchase-moment.cdc`, which is auto-generated. The corresponding production-source line in `lib/cadence/purchase-moment.ts` is offset by the export header (the fixture starts at line 1 with the auto-generated banner; the production file starts the Cadence body around line 39).

The two warnings (string-concatenation hints) are not regressions and do not affect the exit code.

## Flipping the harness GREEN

When C1 and C2 are fixed in `lib/cadence/purchase-moment.ts`, all three semantic errors disappear and `npm run test:cadence` exits 0. From that point on, any future regression in the production transaction (a new uninitialized field, a removed import, a renamed entitlement) is caught by re-running the harness.

The H1 and H2 audit findings (commission recipient nil-panic, missing DUC leak post-condition) are NOT caught by this harness. They are runtime-only failures and require an emulator or testnet round-trip to surface. Adding those checks is a future-session task that needs a Dapper testnet co-signer.

## Why DapperUtilityCoin is stubbed

The mainnet contract at `0xead892083b3e2c6c` is Dapper Wallet's internal stablecoin. It is not published to a public source mirror, is not legitimately installable via `flow dependencies install`, and depends on Dapper-internal permission gates and merchant routing logic that cannot be reproduced outside Dapper's infrastructure. The committed stub at `tests/cadence/stubs/DapperUtilityCoin.cdc` is a **type-shape mirror only** — it conforms to `FungibleToken.Vault` so that `auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault` resolves, but its `withdraw`, `deposit`, and `burnCallback` implementations are placeholder behavior. Never deploy it.

## Why TopShot is stubbed

The production transaction imports `TopShot` at the file level but never calls `TopShot.X` in its body — it borrows the buyer collection through `&{NonFungibleToken.CollectionPublic}`. An empty contract stub is sufficient for import resolution and avoids pulling the full `TopShotLocking` / royalty-registry transitive chain. If a future test asserts on TopShot-specific receipt logic, replace the stub with the pulled mainnet source and register the transitive chain in `tests/cadence/flow.test.json`.

## Why two configs

`flow.json` (gitignored) carries the production hot-wallet private key for `0x3aa11c84d776838f` and is used by every Flow CLI command that needs to sign or submit a transaction. Mixing test contract aliases into that file would be safe (it stays gitignored) but creates two failure modes: an accidental commit leaks the key, and an accidental edit during test-config maintenance touches the same file the production tooling reads. The committed `tests/cadence/flow.test.json` carries only the test harness's contract wiring — no accounts, no private keys — and is passed explicitly to `flow cadence lint` via `-f`. Production tooling and test tooling read different files; neither can corrupt the other.

## Extending the harness

When the C1 / C2 fixes land and the harness flips GREEN, plausible next steps in priority order:

1. Add coverage for H1 (`commissionRecipient: nil` panics on Dapper-listed Top Shot moments). This is a runtime check against the real `NFTStorefrontV2.purchase` post-conditions and likely needs a Dapper testnet co-signer plus an emulator-side mock that mirrors Dapper's commission-required behavior.
2. Add coverage for H2 (missing DUC leak post-condition). Same emulator constraint as H1.
3. Add a fixture that asserts the production transaction is signed with exactly the expected authorizers (buyer + Dapper merchant) — catches accidental authorizer changes.
4. Move the harness behind a `--warnings-as-errors` flag once the existing string-concat warnings are resolved (they currently fire on lines 33 and 56; rewriting those to string templates is a separate one-line PR).

Until item 1 is ready, the harness intentionally caps at type-check coverage.
