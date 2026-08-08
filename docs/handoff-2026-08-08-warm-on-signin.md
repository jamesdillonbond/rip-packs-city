# Handoff — Warm new-user wallets deeply + across all collections on sign-in

**Date:** 2026-08-08 (PT)
**Author:** Cowork session (Trevor-directed)
**Type:** Route code change — Cowork can't push, so this is for Claude Code.
**Risk:** Low. Touches only the new-user wallet-association `after()` fan-out; no auth/proxy, no DB migration, no hot wallet.

## Why

The front door opened 2026-07-20 (self-serve, allow-by-default). Open-door users **never get an `allow_list` row**, so they skip the approval-time multicollection prewarm entirely. The account-creation "Load my collection" CTA is now the *only* thing that warms their wallet — and it under-warms:

`app/api/profile/resolve-and-associate/route.ts` (the username → wallet CTA) upserts the `saved_wallets` rows, then in its `after()` block fires a **shallow `/api/wallet-search` with `limit: 50` per collection** (UFC via `ufc-wallet-scan`). That is not a deep Cadence walk. Result:

- Top Shot lands **page-capped at exactly 50 moments** (the `limit: 50` fingerprint), even if the user holds more.
- UFC / Golazos / Pinnacle / All Day land at **0** even when the wallet holds moments there (the shallow search short-circuits for several of them).

**Confirmed live:** `visiondist@gmail.com` signed up 2026-08-08 19:59Z via the open door (no `allow_list` row, magic link confirmed, 5 `saved_wallets` rows auto-attached). Their wallet `0xdcd41c74d2dd0a66` shows **exactly 50** Top Shot moments and **0** in every other collection — the exact signature above.

Trevor's directive: wallets should **warm up immediately and fully across collections as part of the account-creation CTA.**

## The fix

### 1. Primary — deepen the CTA warm (`app/api/profile/resolve-and-associate/route.ts`)

In the `after()` block (currently ~lines 174-225), **replace the per-collection shallow `wallet-search` fan-out with a single dispatch to the deep multicollection backfill**, then keep the existing `aggregate_saved_wallet_stats` RPC.

Change the fan-out to:

```
const res = await fetch(`${base}/api/wallet-backfill-multicollection`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(ingestToken ? { Authorization: `Bearer ${ingestToken}` } : {}),
  },
  body: JSON.stringify({ wallet: walletAddress, skip_cached: false }),
});
if (!res.ok) {
  console.warn(`[resolve-and-associate after] multicollection backfill HTTP ${res.status}`);
}
```

Notes:
- `/api/wallet-backfill-multicollection` already fans out to all 5 published Flow collections: Top Shot (`/api/wallet-backfill`, deep) + Golazos + UFC as fire-and-forget, All Day + Pinnacle as sync children. It returns **202 immediately** and does the heavy walk in **its own** `after()`, so `resolve-and-associate`'s `after()` just fires one POST and returns — no long hold, no maxDuration pressure on this route.
- `skip_cached: false` forces a full re-walk (so the existing capped-at-50 Top Shot rows get replaced with the complete set).
- **Keep** the `aggregate_saved_wallet_stats` RPC call that follows — it reads `wallet_moments_cache` (source of truth) and stamps `cached_moment_count` / `cached_fmv_usd` on the `saved_wallets` rows. But note the deep walk finishes *after* the multicollection route's own `after()`, so the aggregate here will run before the walk completes on first pass; that's fine (the hourly `wmc-fmv-populate` + the aggregate re-run on next dashboard load reconcile it), OR optionally leave a short quick `wallet-search limit:50` for Top Shot only to give instant first-paint numbers while the deep walk fills the rest. Your call — the substance is the deep backfill dispatch.
- `INGEST_SECRET_TOKEN` is already read in this block as `ingestToken`; the multicollection route requires that Bearer.

### 2. Secondary — the direct-address entry path (`app/api/profile/saved-wallets/route.ts`)

This route (used when a user pastes a `0x...` address instead of a Dapper username) does **no warm dispatch at all** on insert, and its `maybeAutoAttachAllowListWallet` self-heal keys off `allow_list` — so it's also blind to open-door users. Apply the same one-shot `wallet-backfill-multicollection` dispatch (fire-and-forget via `after()`, `skip_cached:false`) after a successful wallet insert, so the direct-address path warms across collections too.

### 3. Optional hardening — first-login safety net

Consider dispatching the multicollection backfill once on first dashboard load for any logged-in user whose wallet has `saved_wallets` rows but zero `wallet_moments_cache` rows (covers users who bounce mid-CTA). Lower priority than 1 and 2.

## Verify after ship

- Fresh open-door signup: their wallet populates **every collection they hold**, and Top Shot is no longer pinned at exactly 50.
- Re-run the `rpc-pending-signups-watch` Check 6b (cross-collection warm) — it should stop finding Top-Shot-only / exactly-50 wallets.
- CI: `tsc --noEmit` + `npm run test:coverage` green (no threshold change expected; this is behavioral).
- Ledger: add an entry (date · what shipped · revert path).

## Revert

`git revert <sha>` — pure code change, nothing to unwind in the DB.

## Interim (already actioned by Trevor out-of-band)

`visiondist@gmail.com`'s wallet was warmed manually via:
`POST /api/wallet-backfill-multicollection` body `{"wallet":"0xdcd41c74d2dd0a66","skip_cached":false}` (Bearer `INGEST_SECRET_TOKEN`).
