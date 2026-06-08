# Candy launch-readiness gaps (audit addendum, 2026-06-08)

> **UPDATE 2026-06-08 (Claude Code) — foundation landed; per-site routing revised.** The reusable primitive + the two zero-risk anti-corruption/classification fixes + GAP 2 shipped to main this session. The audit's "route all ~40 validators through it now" framing was **revised after reading the call sites**: most of those "Flow-only regex" gates are the *last* Flow assumption in front of a stack of Flow-specific machinery (e.g. `wallet-search` gates `ensureFlowPrefix` + topshot GQL + the TS username resolver; the public tc-report/squeeze-check tools front Top-Shot-only RPCs). Broadening them in isolation would route a Solana address straight into Flow code — `ensureFlowPrefix` would glue `0x` onto base58 and corrupt it — which is **worse** than today's clean 400. So those validators flip to chain-aware **together with each Candy data surface** (handoff Items 4/5/7 — the Candy-aware wallet resolver), not as a blind sweep in front of empty Flow data.
>
> **Landed this session:**
> - `lib/address.ts` — added `isSolanaAddress` (base58 32–44, case-sensitive), `solana` branch on `detectAddressChain`, `ChainKind`, `chainKindForDbChain(dbChain)`, `isValidAddressForChain(value, dbChain)`, `isSupportedAddress(value)`, and `normalizeAddress(value)` (case-safe — preserves base58 case, lowercases hex). This is the audit's "pays for chain two AND three" primitive and is the chokepoint future site-routing imports from.
> - `lib/collections.ts` (GAP 2) — Candy moment→Magic Eden item-details + wallet→Magic Eden `/u/`; Panini wallet→OpenSea profile. (Candy/Panini per-asset moment links need the bridge contract / mint, still NULL until discovery.)
> - `app/dashboard/page.tsx` — `truncateAddress` no longer prepends `0x` to a base58 address (anti-corruption; the user's linked-wallets hub is genuinely cross-chain once a Candy wallet is linked).
> - `app/api/profile/recent-searches/route.ts` — `inferType` uses `isSupportedAddress` (pure search-history classification, no Flow machinery behind it).
>
> **Deliberately left Flow-only (correct until a Candy data surface exists):** wallet-search/preflight/wallet-packs (front TS GQL + `ensureFlowPrefix`), the public tc-report/squeeze-check/wallet-intel tools (TS-only RPCs), concierge wallet tools, owned-flow-ids (Flow on-chain ids), the collection-page `input_kind`/UFC-scan branches, the player-page sales-table truncator (no Candy `player` page — Candy `pages` = overview/collection/packs/sniper), and the entire analytics/Fast-Break/RTR/team/AllDay surface (Flow data plane / Flow game features). Each gets `isValidAddressForChain(addr, collection.dbChain)` when its Candy resolver lands.

Companion to docs/handoff-2026-06-08-candy-panini-onboarding.md. This is the "what breaks when a non-Flow (Solana) collection's data actually flows in" audit — the hidden Flow assumptions that the ingest plan alone does not cover. Read-only audit; nothing changed. Found by grepping the live tree this session, so treat the file list as current (verify exact lines when you touch them; Claude Code's inspection wins).

## GAP 1 (LAUNCH-BLOCKING) — wallet address format is hard-coded to Flow in ~40 sites

Flow address = 0x + exactly 16 hex chars (regex /^0x[0-9a-fA-F]{16}$/). Solana address = base58, ~32-44 chars, NO 0x prefix. Candy wallets are Solana base58, so every Flow-format gate rejects/skips/corrupts them. lib/address.ts already has isCadenceAddress + isEvmAddress + detectAddressChain (returns "cadence"|"evm"|"unknown") but NO Solana branch, and it is imported in only ONE file (app/api/wallet-search/route.ts) — the other ~40 sites each define their own local regex. So there is no single chokepoint; this is real, distributed work.

Recommended fix (do this as its own commit, ideally before wiring Candy wallet reads — Items 4/5/7 in the main handoff):
- Extend lib/address.ts: add isSolanaAddress(value) (base58, length ~32-44; use a base58 charset check, not a length-only check) and extend detectAddressChain to return "solana". The EVM regex already there is also what the Panini Ethereum bridge needs.
- Add a chain-aware validator that takes the collection's chain (from the registry dbChain / collection_chains) and validates accordingly, then route the scattered sites through it instead of inlining /^0x...{16}$/.

Three failure classes, worst first:

(a) PREPENDERS — corrupt a base58 address by gluing "0x" on:
- app/dashboard/page.tsx:152  const clean = addr.startsWith("0x") ? addr : "0x" + addr
- app/(collections)/[collection]/player/[slug]/page.tsx:240  lower = ...startsWith("0x") ? ... : `0x${...}`
- supabase/functions/scan-ufc-wallet/index.ts:141  if (!wallet.startsWith("0x")) wallet = `0x${wallet}`  (Flow-only fn; just don't reuse this pattern for Solana)

(b) SKIP/MISCLASSIFY GUARDS — silently drop or mis-handle non-0x wallets:
- app/(collections)/[collection]/market/page.tsx:222  if (!ownerKey || !ownerKey.startsWith("0x") || !collectionId) return  -> Solana wallet never loads market
- app/(collections)/[collection]/collection/page.tsx:1080  input_kind: trimmed.startsWith("0x") ? "address" : "username"  -> a Solana address gets treated as a username (lookup fails). Also the startsWith("0x") branches at ~1029, 1120 (ufc-gated), 1247.
- app/(collections)/[collection]/analytics/page.tsx:1031 and app/(analytics)/analytics/wallets/[address]/page.tsx:154 — username-vs-address branching on startsWith("0x").

(c) HARD VALIDATORS (regex .test) — reject the address outright (return 400 / notFound / "invalid"):
- Public wallet-paste tools (these are the onboarding funnel): app/insights/tc-report/page.tsx + app/api/public/insights/tc-report/route.ts; app/insights/squeeze-check/page.tsx + app/api/public/insights/squeeze-check/route.ts; app/api/public/wallet-intel/route.ts
- Core wallet entry: app/api/wallet-search/route.ts:112; app/api/wallet-preflight/route.ts:58; app/api/wallet-packs/route.ts:65; app/api/owned-flow-ids/route.ts:23
- Concierge: app/api/support-chat/route.ts:956 and :1030 (isHex gate on the wallet tools)
- Profile/search/recent: app/api/profile/recent-searches/route.ts:13; lib/pro-tier.ts:51; lib/analytics/username-resolver.ts:19
- Flow-specific-by-design (leave as-is, they should stay Flow-only): fast-break / rtr / road-to-the-ring / team-* / allday-* / entity team-* validators. Do NOT make Fast Break/RTR accept Solana — those are Top Shot game features. Scope the chain-aware change to the cross-collection + Candy-reachable surfaces (wallet-search, preflight, the public wallet-intel/tc-report/squeeze-check tools, concierge, profile, market, collection, share, analytics wallet pages).

Truncation display helpers (addr.slice(0,6)+"…"+addr.slice(-4)) mostly work fine on base58 (cosmetic only) — no change needed except where they sit behind a startsWith("0x") guard (covered above).

Net: until GAP 1 is addressed, a Candy (Solana) wallet pasted into RPC is rejected by the public tools, mis-routed as a username by the collection page, and corrupted by the dashboard. This is the #1 thing that turns "Candy is wired" into "Candy actually works for a user." Size it as a focused chain-aware-address commit.

## GAP 2 (SMALL) — marketplace URL builders are Flow-only

lib/collections.ts MARKETPLACE_MOMENT_URL_TEMPLATES + MARKETPLACE_WALLET_URL_TEMPLATES only have entries for the 4 Flow marketplaces (nbatopshot/nflallday/laligagolazos/disneypinnacle). For Candy, add Solana targets: a moment/asset link to Magic Eden (https://magiceden.io/item-details/<mint>) or Solscan (https://solscan.io/token/<mint>), and a wallet link to Magic Eden (https://magiceden.io/u/<addr>) or Solscan (https://solscan.io/account/<addr>). For Panini's bridged subset, an OpenSea/Etherscan template. Surfaces that call marketplaceMomentUrl/marketplaceWalletUrl return null for Candy until these exist (graceful, just no "view on marketplace" link).

## VERIFIED OK (no change needed)

- FMV / editions / sales / wmc / fmv_snapshots are chain-implicit via collection_id (chain-abstraction Phase E classified them chain-internal). The FMV engine (app/api/fmv-recalc/route.ts) keys by edition, not wallet/chain — point it at the Candy collection_id and it runs. Expect thin/LOW confidence early on a fresh order book; that is correct.
- collections-table reads are all single-slug lookups (.eq("slug",...).single()) or .in("id", ids) scoped to a wallet's holdings — none list all collections, so the inert candy_mlb/panini_blockchain rows (is_active=false, 0 holdings) cannot leak into any page, sitemap, smoke test, or health check. (QA'd this session.)
- collection_chains view does NOT filter is_active, but its only consumers are internal chain-dispatch joins, not public lists — safe.

## Bonus: this is broader than Candy

GAP 1 is the blocker for ANY non-Flow chain — the Panini Ethereum bridge (chain=ethereum) and the existing Beezie/Base evm_* plane both hit it the moment they get a wallet-facing surface. Fixing lib/address.ts properly (cadence + evm + solana) pays for chain two AND three. Worth tracking as its own ledger item even independent of Candy timing.
