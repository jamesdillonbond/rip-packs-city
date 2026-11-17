# Handoff — 2026-07-29 · wallet capability tiers, and the FCL config collision

## Context

Trevor's product ruling: **a Dapper Wallet sign-in grants read-only capability; a self-custody Flow Wallet linked as the Hybrid Custody parent is what unlocks advanced/transacting capability.** That is exactly the Flow Hybrid Custody model, and the data to enforce it already exists and is fresh.

**Already shipped from Cowork, needs nothing from you:** `audit_20260729_wallet_capability_tier_view` → `public.v_wallet_capability_tier`. Verified: 239 addresses (95 `advanced` / 99 `child` / 45 `standalone`), `security_invoker=on`, `anon` SELECT false, `check_public_security_invariants()` **0**.

Items 17 and 18 below are code.

---

## What is actually wrong today

### The FCL config collision — verified in the shipped bundles, not just source

Two modules both write FCL's **global singleton** `discovery.wallet`, each behind its own init guard that cannot see the other:

| module | endpoint | how it runs |
|---|---|---|
| `lib/chains/flow/flow.ts` → `initFcl()` | `https://accounts.meetdapper.com/fcl/authn-restricted` | **auto-executes on import** (last line of the file) |
| `lib/chains/flow/fcl-config.ts` → `configureFclAuth()` | `https://fcl-discovery.onflow.org/authn` | called from `components/SignInWithDapper.tsx:38`, `app/dashboard/page.tsx:1973` |

Confirmed live: **both endpoints ship to `/dashboard`** — I fetched the served bundles and found `accounts.meetdapper.com/fcl/authn-restricted` baked verbatim in two of them and `fcl-discovery.onflow.org/authn` in two others. The collision is real on a single route, and which one wins is import-order dependent. `flow.ts` gets pulled in transitively by the cart (`lib/cart/usePurchaseQueue.ts`) and `lib/hooks/useFlowUser.ts`, both dashboard-adjacent.

Also worth knowing: `/login` has **no wallet path at all** — it is magic-link only. Any wallet prompt is the dashboard's connect flow. And the `blocto` string in the bundle is inside the **FCL vendor code**, not RPC config — so if a dead wallet is being offered, it is coming from FCL's own service list, not from anything you configured.

### The correct path exists and is used once

`initFclSelfCustody()` in `flow.ts` points at self-custody discovery and its own comment says it is for flows where *"the signer is the Hybrid-Custody **parent**, never the Dapper-custodial child."* Exactly one caller: `app/dashboard/gift/GiftClient.tsx:244`. The right idea is already in the codebase, wired into gifting and nowhere else.

### The graph is live but ungated

`linked_accounts` — fed by the `hybrid_custody_events` indexer — holds **99 active links, 95 distinct parents, latest event 2026-07-29 02:33Z**. All 126 rows are `relationship = 'restricted'`. It is read by only `app/api/gift/children/route.ts` and `app/api/profile/verify-link/route.ts`. **Nothing uses it to decide what a signed-in wallet is allowed to do.**

---

## 17. Make FCL config single-owner, and default sign-in to self-custody

**Files:** `lib/chains/flow/flow.ts`, `lib/chains/flow/fcl-config.ts`, `components/SignInWithDapper.tsx`

1. **Remove the auto-init side effect.** Delete the bare `initFcl()` call at the bottom of `flow.ts`. A module import must not mutate global wallet config. The comment says it prevents INVARIANT errors on cold starts — if that is still true, fix it with an explicit init at the entry points that need it, not an import side effect.
2. **One owner for `discovery.wallet`.** Collapse to a single function that takes the intent — e.g. `configureFcl({ intent: 'read' | 'transact' })` — so there is exactly one place the endpoint is decided. Keep the account-proof nonce resolver from `fcl-config.ts`; it is correct.
3. **Sign-in defaults to self-custody discovery.** `fcl-discovery.onflow.org/authn`, so a real Flow Wallet is the primary path.
4. **Scope Dapper-restricted to where a Dapper child genuinely signs**, if anywhere. Do not leave it as the global default.
5. **Pin the wallet allowlist.** FCL supports constraining which services Discovery offers. Whitelist Flow Wallet explicitly so a deprecated wallet cannot be presented just because FCL's list still carries it. This is the fix for the Blocto sighting regardless of which endpoint served it.
6. **Add a test asserting only one module writes `discovery.wallet`** — grep-level is fine. The defect is not either value; it is that two places can set it.

**Verify:** `/dashboard` connect-wallet offers Flow Wallet, no deprecated wallet appears, and gifting still works (it is the one existing self-custody consumer). `npx tsc --noEmit` clean.

**Revert:** revert the commit; both endpoints are already in the tree.

## 18. Gate capability on the parent link

**New consumer for:** `public.v_wallet_capability_tier`

```
address · role (parent|child|standalone) · capability_tier (advanced|read_only)
is_active_parent · is_active_child · active_children · active_parent_addr · last_link_event_at
```

Read it wherever the UI decides whether to offer a transacting action (gifting, listing, purchase, any signing). `advanced` ⇒ offer it. `read_only` ⇒ show the read-only state and an explain-and-link affordance: *"connect your Flow Wallet as parent to do this."*

⚠ **Absence is not `read_only`.** An address with no row is simply **unknown** to the Hybrid Custody indexer — most likely an ordinary self-custody wallet that never linked anything. Do **not** LEFT JOIN and coalesce to `read_only`; that silently downgrades every normal wallet on the platform. Treat no-row as unknown and decide separately. This is written into the view's `COMMENT` too.

⚠ Every row today is `relationship = 'restricted'`. If an `owned`/unrestricted type ever appears, revisit — an unrestricted child has broader rights than the view assumes.

**Verify:** a known parent address resolves `advanced`, a known child resolves `read_only`, and an address absent from `linked_accounts` is treated as unknown rather than downgraded — assert that last one in a test, it is the failure mode that will actually bite.

**Revert:** revert the commit; `DROP VIEW public.v_wallet_capability_tier;` if the DB half is also being backed out.

---

## Why this is a real pre-multi-chain gate

Trevor's instinct to settle wallets before going multi-chain is well-founded, and the reason is concrete: the parent/child capability distinction is **already modelled in the data** and **not enforced anywhere in the UI**, so today the app cannot correctly answer "what can this user do?" for Flow — the chain it knows best. Candy is Solana, where none of the Flow wallet story transfers: no FCL, no Hybrid Custody, different signing entirely. Shipping a second chain on top of an unenforced capability model on the first one means building the same ambiguity twice.

## Guardrails

Unchanged. Relevant here: a `CREATE OR REPLACE VIEW` drops `reloptions` and re-attaches Supabase's default anon grant — the migration above restates `security_invoker` and revokes anon explicitly, and ends by reading `check_public_security_invariants()`. Do the same on any follow-up.

**Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.**

## Expected end state

Exactly one module writes `discovery.wallet`; sign-in offers a real Flow Wallet with a pinned allowlist; Dapper-restricted appears only where a Dapper child genuinely signs; and transacting affordances are gated on `v_wallet_capability_tier` with absence treated as unknown rather than read-only.
