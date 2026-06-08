# Spec — HybridCustody read-only wallet-verification path

Status: SPEC (not yet greenlit to build). Owner: Trevor's call to schedule; build is a CC handoff. Ties to CLAUDE.md known-issue #0 (wallet verification). Inspiration: Top Shot Community Rewards (topshotcommunityrewards.com) — see docs/research/competitive-recon-vaultopolis-tscr-2026-06-08.md. Drafted 2026-06-08 by Cowork (read-only investigation; nothing shipped).

## Problem

RPC's rewards economy gates Moment/Pro redemptions behind a verified wallet (the sybil guard, surfaced as onboarding — `no user-writable points path` invariant). Today there are three verify paths, each with friction:

- **Listing challenge** (canonical, shipped 2026-06-07) — RPC picks a cheap Moment, the user lists it at a unique ~100×/$10-floor price, `/api/profile/verify-challenge/check` confirms it live via the topshot-proxy GQL then calls `resolve_wallet_challenge_match` (+500 credits). Works, but asks the collector to create a real listing and undo it — meaningful friction, and only works for Moments the wallet can list.
- **FCL self-custody** (`verify_wallet_via_fcl(p_user_id, p_wallet_addr, p_method)`, SECDEF) — fine for self-custody Flow wallets, but most Top Shot collectors hold inside **Dapper**, which doesn't expose signing keys to FCL discovery (Flow Wallet / Blocto don't custody TS accounts). So the FCL button is dead-end for the core TS audience.
- **`admin_verify_wallet`** — manual owner attestation; doesn't scale.

The gap: a Dapper collector who ALSO controls a self-custody Flow wallet that is **HybridCustody-linked** to their Dapper account has no low-friction path. TSCR solved exactly this — "Connect with Dapper or any Flow wallet through FCL Discovery… Read-only — you never sign a transaction" — by walking HybridCustody account links to surface Moments across linked accounts. 120 verified collectors, no listing dance.

## RPC already has the infrastructure

Verified live 2026-06-08 (project bxcqstmqfzmuolpuynti):

- `hybrid-custody-proxy.tdillonbond.workers.dev` — HybridCustody event reads against contract `0xd8a7e05a7ac670c0` (Bearer `INGEST_SECRET_TOKEN`).
- Edge functions `hybrid-custody-events` + `hybrid-custody-backfill` — ingest child-publish / revoke events into `linked_accounts` (cron every 20 min).
- Table `linked_accounts(parent_addr, child_addr)` — **51 pairs live now** (was 6 in May; ingest is actively growing it).
- Reader RPCs (all present): `get_linked_parents(addr)`, `get_linked_children(addr)`, `get_all_linked_addresses(addr)` (NOT SECDEF — plain reader), `is_account_linked(addr)`, `linked_accounts_summary()`.
- `verify_wallet_via_fcl(p_user_id, p_wallet_addr, p_method)` SECDEF — the FCL resolver that flips `saved_wallets.verified_at` and awards `link_wallet` (+500). The `p_method` arg already parameterizes the verification method, so a new method value slots in without a new RPC.

So the only genuinely new pieces are (a) a server route that ties an FCL account-proof to a HybridCustody-link check, and (b) the front-end connect button + copy. No new worker, no new ingest, no new table.

## Proposed flow

1. **User connects any Flow wallet via FCL with account-proof.** This must be a *cryptographic* proof of control of the connected address `A` (FCL `accountProof` / signed nonce), NOT a bare address claim. (Confirm the existing FCL verify route already does account-proof; if it currently trusts a posted address, that hole must be closed as part of this work — a posted address is spoofable and would let anyone verify any linked wallet.)
2. **Server resolves the link graph:** `get_all_linked_addresses(A)` → the set of addresses HybridCustody-linked to the proven address (parents + children, transitively).
3. **Match against the claimed collection wallet `W`** (the saved_wallets row the user wants verified — the one holding their TS collection). If `W ∈ get_all_linked_addresses(A)` OR `W == A`, ownership-of-control is proven: the user cryptographically controls an address on-chain-linked to `W`.
4. **Resolve verification** via `verify_wallet_via_fcl(user_id, W, 'hybrid_custody_link')` (new method value) — atomically flips `saved_wallets.verified_at` and awards `link_wallet` (+500), exactly like the other paths. user_id is session-resolved (`requireUser()`), never client-supplied (preserves the no-user-writable-points invariant).
5. **Fallback:** if `A` has no link to `W` (collector never linked accounts), fall through to the existing listing challenge with a clear message — don't dead-end.

Trust copy, mirror TSCR: "Connect read-only — we never ask you to sign a transaction" (account-proof is a signed message, not a transaction; word it as collectors expect).

## Where it slots in (verified file references)

- New route: `app/api/profile/verify-link/route.ts` (sibling to `app/api/profile/verify-challenge/check/route.ts` — copy its `requireUser()` + in-memory rate-limit + `normalizeAddr` scaffolding).
- Reuse the existing FCL connect/account-proof client the FCL verify button already uses (locate the current `/api/auth/fcl-verify`-class route — Cowork could not confirm its exact path via glob; CC to grep `verify_wallet_via_fcl` callers: dashboard/page.tsx is one).
- DB: extend `verify_wallet_via_fcl` to accept `p_method='hybrid_custody_link'` (it already takes a method arg — likely just an allowed-value addition; confirm the body branches on method, and re-assert grants per the CREATE-OR-REPLACE-resets-grants rule).
- UI: a "Verify via linked wallet (read-only)" button beside the existing listing-challenge + FCL options in the verify surface (dashboard saved-wallets / rewards onboarding).

## Security checklist (must hold)

- The connected address MUST be proven by signature (account-proof), not posted. This is the whole sybil guard — re-verify the FCL path actually checks the proof server-side.
- The link must come from `linked_accounts` (on-chain HybridCustody events), never user input.
- `verify_wallet_via_fcl` stays SECDEF + service_role-only EXECUTE; user_id session-resolved; no amount/points argument (the existing invariant). After any signature change: REVOKE from PUBLIC/anon/authenticated, GRANT to service_role, DROP old overload.
- Rate-limit the route (the challenge route's 6/min/user pattern).
- It only flips `verified_at` + awards the one-time +500 `link_wallet` (per_user_limit=1 already enforced DB-side, so re-runs are harmless no-ops).

## Why it's worth it

It removes the single biggest verification-friction point for the exact audience RPC targets (Dapper TS collectors), reusing infra that already runs daily — it's known-issue #0 work, NOT a new rewards build (rewards board stays clear until the Monday pulse shows usage). TSCR is live proof collectors will verify when the flow is read-only and trust-framed. Effort is one route + one RPC method-value + one button; no new worker/table/cron.

## Not in scope

Surfacing Moments across linked accounts in the portfolio (RPC already aggregates via saved_wallets); on-chain reward minting (RPC rewards stay off-chain); any transaction-signing path.

## Verification corrections (2026-06-08 — premises checked read-only)

The spec is buildable largely as written; the verification pass confirmed B/C/D with tweaks and surfaced one finding more important than the feature.

- **PREMISE A — the gate was leaky (must fix BEFORE/independent of this build).** The spec assumed "the verified-wallet redeem gate is the sybil guard." It was NOT actually gating: any authenticated user could self-verify any wallet with zero proof. Two DB vectors were closed live 2026-06-08 (migration `audit_20260608_close_verified_wallet_selfwrite_holes` — revoked `saved_wallets` write grants from anon/authenticated + `verify_wallet_via_fcl` non-service_role EXECUTE). A THIRD route vector is still open pending CC: `app/api/auth/fcl-verify/route.ts` marks `body.addr` verified but only proves `proof.address` — assert they're equal. Full detail + the route one-liner: docs/handoff-2026-06-08-verified-wallet-security.md. Do not ship the HybridCustody path (which removes verify friction) until vector #1 is closed — otherwise it removes friction on a gate that still isn't gating. The route layer DOES do real account-proof (single-use 5-min nonce via app/api/auth/fcl-nonce/route.ts + fcl.AppUtils.verifyAccountProof) — the leak is the trust boundary, not the crypto.
- **PREMISE B — method arg parameterized, with a catch.** `verify_wallet_via_fcl` branches `IF p_method NOT IN ('fcl_dapper','fcl_blocto','fcl_other') THEN RAISE` — so `'hybrid_custody_link'` is REJECTED today; add it to the IN-list (one line). CREATE OR REPLACE resets grants → re-assert **service_role-only** (NOT authenticated — that's vector ii, just closed).
- **PREMISE C — linked-accounts infra confirmed, number corrected.** `get_all_linked_addresses(addr)`, `get_linked_parents`, `get_linked_children` are plain STABLE readers filtering `active = TRUE`. Pairs: 51 total but only **40 ACTIVE** (the readers see 40). Use `get_all_linked_addresses` (it returns the transitive set).
- **PREMISE D — scaffolding confirmed.** Connect client is **components/SignInWithDapper.tsx** (the spec's "couldn't confirm path"); route app/api/auth/fcl-verify/route.ts; nonce app/api/auth/fcl-nonce/route.ts. Build notes: `verify_wallet_via_fcl` only UPDATEs an EXISTING `saved_wallets` row for (user_id, addr) — so ensure wallet W is saved first; and normalize address casing to lowercase 0x-16hex before `get_all_linked_addresses` (linked_accounts stores lowercase).
