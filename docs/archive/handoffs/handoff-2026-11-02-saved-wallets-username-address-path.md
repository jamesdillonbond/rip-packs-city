# Handoff — `saved_wallets.username` null on address-entry signups

**Date:** 2026-11-02 (~9:35 AM PT) · **Author:** Cowork (onboarding-funnel watch follow-up) · **For:** Claude Code on Trevor's machine
**HEAD at authoring:** `a9e27f79d` on `main`.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

> ✅ **SHIPPED 2026-11-03 ~7:25 AM PT (Claude Code cloud)** — Item 1 done as specified: the address branch reverse-resolves from `wallet_usernames` (bounded, fail-soft), tests in `__tests__/api-profile-resolve-and-associate-handle.test.ts`. Ledger 11-03.

## Context

Surfaced by the daily onboarding-funnel watch while answering "what is their username?" for a new organic signup (email redacted — public repo).

**Already shipped live by Cowork this session (NOT part of this handoff — do not redo):** a one-off data backfill applied directly via the Supabase SQL path —

```sql
UPDATE saved_wallets s SET username = wu.username
FROM wallet_usernames wu
WHERE s.wallet_addr = wu.wallet_addr
  AND s.username IS NULL
  AND wu.username IS NOT NULL;
```

That fixed the **21 existing null rows** (4 open-door signups × 5 collection rows + 1 legacy row). Verified afterward: `saved_wallets` is now `null_username = 0` of 185. The backfill is reversible per-row only if you kept a snapshot — none was taken, but the value written is just the authoritative `wallet_usernames` copy, so it is self-evidently correct and re-derivable.

**This handoff covers the root-cause code fix** so future signups don't recreate the gap. It is a `.tsx`/route change Cowork can't push to git.

## Item 1 — `resolve-and-associate` address branch never resolves the username

**File:** `app/api/profile/resolve-and-associate/route.ts` (verified present; the branch is around lines 101–111, the upsert/update around 234–250, the public-handle claim around 269–270 — line numbers may drift, match on the code).

**Root cause.** The "Load my collection" CTA accepts either a Dapper **username** or a raw **wallet address**. In the address branch:

```ts
if (rawAddress) {
  ...
  walletAddress = normalizeAddress(rawAddress);
  username = null;          // ⟵ hard null, never reverse-resolved
} else {
  ... username = outcome.username;   // username path DOES resolve
}
```

The later upsert writes `username` into the rows, but the follow-up correction `if (!error && username) { ...update({ username }) }` only runs when `username` is non-null. So **every signup who pastes their wallet address gets `saved_wallets.username = null` on all 5 collection rows** — even though the handle is almost always already in `wallet_usernames` (the reverse map, ~9,370 entries per the comment in this same file). The same null also skips `claimUsernameFromTopShot(...)` (gated on `username` ~line 269), so these users additionally get **no public `/profile/<handle>`** — the exact "16 of 20 collectors had no public profile" problem that block was written to solve, reopened for the address path.

**Verified counts (read-only queries, this session):** 4 of 4 open-door signups that have saved wallets (emails redacted — public repo; identified below by their usernames) had null `username` on every row; all 4 wallets' handles were present in `wallet_usernames` (`ReddieMiller31`, `sdb`, `AnythingIsPossible`, `ripe_pied_tamarin6313`). Confirmed by joining `saved_wallets` → `wallet_usernames` on `wallet_addr`.

**Fix.** In the `rawAddress` branch, after `walletAddress = normalizeAddress(rawAddress)`, reverse-resolve the handle from `wallet_usernames` instead of hard-nulling; leave it null only if genuinely unknown. Use the pattern already in the tree at `lib/giveaways/store.ts:269`:

```ts
walletAddress = normalizeAddress(rawAddress);
const bare = walletAddress.startsWith("0x") ? walletAddress.slice(2) : walletAddress;
const { data: wu } = await supabase
  .from("wallet_usernames")
  .select("username")
  .in("wallet_addr", [walletAddress, bare])
  .limit(1)
  .maybeSingle();
username = (wu?.username as string | undefined) ?? null;
```

This is a read, not a write, and must fail-soft (a lookup error → `username = null`, same as today — never block the save). Setting `username` here flows through unchanged to both the `saved_wallets.username` correction and the public-handle claim, fixing both symptoms with one lookup. Do **not** reach for the live Top Shot GQL here — `wallet_usernames` is the cache precisely because that endpoint is unreliable (see the long comment in this file); a cache miss should stay null, not 502 the save.

**Revert path:** revert the single commit for this change. No DB or migration component (the data backfill above is independent and stays).

**Expected verification:**
- `npx tsc --noEmit` clean.
- Vercel deploy reaches READY.
- Smoke: resolve a wallet whose handle is in `wallet_usernames` **by address** (not username), then confirm the new `saved_wallets` rows carry `username`, and `profile_bio.username` got claimed. A wallet with no `wallet_usernames` entry should still save fine with null username (no 502, no 500).
- Add/extend a test alongside the route's existing suite asserting the address branch populates `username` from `wallet_usernames` and fail-softs on a miss.

## Guardrails (repeat every handoff)

- **Direct to `main`, no branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0).
- This no-push note is **specific to the Cowork cloud session** that wrote this doc. Trevor's machine and Claude Code push normally via Git Credential Manager / `gh auth setup-git` — ⛔ never write a PAT into `remote.origin.pushurl` (that route is DEAD, burned + removed 2026-08-16). Commit as usual.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` if you touch the Vercel API.
- CRLF: don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines.

## Expected end state

One commit on `main`, Vercel READY, and every future address-entry signup lands with `saved_wallets.username` populated and a public profile handle claimed — matching the username-entry path. The 21 historical rows are already backfilled live.
