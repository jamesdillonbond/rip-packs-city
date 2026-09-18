# Handoff — delete-not-seen on a complete wallet backfill (phantom holdings overcount)

> ✅ **EXECUTED — DO NOT RE-IMPLEMENT. Committed 2026-09-14 4:41 PM PT as `8beb4686c`** (*"fix(wmc): delete-not-seen on every complete wallet backfill"*), found by message per the post-`filter-repo` rule. **§1–§6 are DONE:** it added `lib/chains/flow/wmc-unseen-delete.ts` (its own module, deliberately — see the ledger on why importing it through `wallet-backfill-helpers` would have made it a STUB on the Top Shot path) and changed `app/api/wallet-backfill/route.ts`, `lib/chains/flow/wallet-backfill-helpers.ts` and three test files. This document is kept as the DESIGN RECORD for that commit, not as an open request.
>
> ⚠ **§7 (the one-off SQL to clear the 50 phantom rows for `0x0d79d58c5fe83cdc`) was deliberately NOT run and is still not run.** The ledger states why: it is the `last_seen_at` shortcut this whole document argues against, safe only because those 50 ids were hand-verified, not generalisable — **and the user's next complete backfill fixes it properly anyway.** It is Trevor's call, not a chore. ⛔ **As of 2026-09-18 it could not be run regardless** — the database is unreachable (register #122).
>
> **Revert:** `git revert` the commit found by `git log --grep="delete-not-seen"`. **No DB half.**


**Date:** 2026-09-14 (PT) · **Author:** Cowork onboarding-watch session
**HEAD:** unknown — the Cowork shell workspace is down (the Sept-8 Windows-update mount failure; `mcp__workspace__bash` cannot mount the repo), so I could not `git rev-parse`. Claude Code: record the HEAD you build on.
**Ships nothing live from Cowork** — this is 100% route/worker code + tests, which Cowork cannot push. Nothing in this handoff has been applied to `main` or the DB. The one optional immediate-relief SQL (danmunroe cleanup, §7) is *proposed*, not run.

> Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.

---

## 1. Context / root cause

`wallet_moments_cache` (wmc) is only ever **written** by the backfill ingest path (`upsert_wmc_batch` / `upsert_wallet_moments`, via `upsertWmcChunks`). Nothing deletes a row when a moment **leaves** a wallet. The only cleanup is `prune_stale_wmc()` (pg_cron `rpc-weekly-wmc-prune`, Sundays 10:20 UTC), which deletes rows whose `last_seen_at < now() - 14 days` for non-seeded wallets.

Consequence: when a user sells/transfers a moment, its wmc row lingers up to **14 days**, plus up to 7 more until the next weekly run — a **~14–21 day window** where the dashboard, `/share` card, and `saved_wallets.cached_moment_count` (reconciled nightly from wmc) **overcount** that user's holdings. This is the honesty defect class CLAUDE.md guards hardest (an account-level false claim).

**Confirmed live case (2026-09-14):** new user `danmunroe@gmail.com`, wallet `0x0d79d58c5fe83cdc`. A forced complete Top Shot backfill today (`wallet-backfill`, `terminated_reason=no_more_moments`, `on_chain_count=1109`, 56 pages) re-saw 1,109 moments. wmc holds **1,159** — 50 distinct moment_ids last seen at signup (09-13 19:00), **none** present in today's complete pass. His card overcounts Top Shot by 50 and won't self-correct until ~early October.

Blast radius today is tiny (5 non-seeded real-user wallets), but it grows with every user who trades.

### Why this MUST key on the observed id-set, not on `last_seen_at`

I dry-ran the naïve "delete rows with `last_seen_at` older than the last complete pass" rule across the 5 real wallets. It would have deleted **100 of 100** real, currently-held All Day moments from wallet `0xba1a13299beb4b19`. Reason: that wallet's last complete All Day pass **found 100 but wrote 0** (all already cached), and `upsert_wmc_batch` is change-detecting — a skip-cached pass confirms presence **without bumping `last_seen_at`**. So `last_seen_at` is NOT a reliable "seen in the latest pass" signal. **The delete must compare cached moment_ids against the set of ids the pass actually observed on-chain**, which only the backfill code holds. (This is also why a DB-only pg_cron prune cannot do it safely — do not build one.)

---

## 2. The fix (one shared helper + guarded call sites)

Add a delete-not-seen step that runs **only on a genuinely complete pass** and deletes cached moment_ids for `(wallet, collection)` that are **not** in the observed id-set.

### 2a. New helper — add to `lib/chains/flow/wallet-backfill-helpers.ts`

`loadCachedMomentIds(wallet, collectionUuid)` already exists in this file (returns `Set<string>` via keyset paging) — reuse it. Add:

```ts
// Delete wmc rows for (wallet, collection) whose moment_id is NOT in the set the
// completing pass actually observed on-chain. This is the ONLY safe way to remove
// a moment the wallet no longer holds: last_seen_at is NOT reliable (a skip-cached
// pass confirms presence without bumping it — verified 2026-09-14, wallet
// 0xba1a13299beb4b19 found 100 / wrote 0), so we diff against the observed id-set.
//
// SAFETY CONTRACT — the caller MUST guarantee all of these before calling:
//   1. The pass is COMPLETE (walked the full holdings): complete=true AND not a
//      soft-deadline / paginated-partial / error / skip / timeout exit.
//   2. `observedIds` is NON-EMPTY. A zero-length scan is never a delete trigger —
//      an empty result is indistinguishable from a degraded read (nil capability
//      borrow returns [] just like an empty wallet). Genuinely-emptied wallets are
//      handled by the 14-day prune backstop, which stays.
//   3. For AllDay, `observedIds` INCLUDES the studio (locked) moment ids AND the
//      studio walk succeeded (studio_ok) — a locked moment is legitimately absent
//      from the chain, so deleting on a degraded custody walk would wrongly remove
//      real holdings. If studio degraded, DO NOT call this.
//
// Defensive cap: if the diff would delete >90% of cached rows AND the wallet has
// >100 cached rows, SKIP the delete this pass and log unseen_delete_suspiciously_large
// — a latent scan bug must not be able to mass-delete a whale's collection in one
// tick. The 14-day prune remains the backstop for a genuine full sell-off.
export async function deleteUnseenWmcRows(args: {
  wallet: string
  collectionUuid: string
  observedIds: Set<string>
  pipelineName: string
}): Promise<{ deleted: number; skippedReason?: "empty_observed" | "suspiciously_large" }> {
  const { wallet, collectionUuid, observedIds, pipelineName } = args
  if (observedIds.size === 0) return { deleted: 0, skippedReason: "empty_observed" }

  const cached = await loadCachedMomentIds(wallet, collectionUuid) // existing keyset-paged reader
  const toDelete: string[] = []
  for (const id of cached) if (!observedIds.has(id)) toDelete.push(id)
  if (toDelete.length === 0) return { deleted: 0 }

  if (cached.size > 100 && toDelete.length > cached.size * 0.9) {
    console.warn(
      `[${pipelineName}] unseen_delete_suspiciously_large wallet=${wallet} ` +
        `cached=${cached.size} would_delete=${toDelete.length} — skipping, leaving to 14-day prune`,
    )
    return { deleted: 0, skippedReason: "suspiciously_large" }
  }

  let deleted = 0
  const CHUNK = 200
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK)
    // deno-lint-ignore no-explicit-any
    const { error, count } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .delete({ count: "exact" })
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      .in("moment_id", chunk) // never a bare NOT IN; always scoped by wallet+collection+id
    if (error) {
      console.warn(`[${pipelineName}] unseen-delete chunk failed: ${error.message}`)
      break
    }
    deleted += typeof count === "number" ? count : chunk.length
  }
  return { deleted }
}
```

### 2b. Call sites (all in the same file unless noted)

Call `deleteUnseenWmcRows(...)` on each **complete-and-non-empty** success path, right after `upsertWmcChunks(...)` and before/around the `logRun(...)`, and add `unseen_deleted` (and any `unseen_delete_skipped` reason) to that run's `extra`. Guard exactly per the safety contract:

1. **`runIdOnlyBackfill`** (UFC + any generic ID-only collection) — success path after `totalUpserted += await upsertWmcChunks(...)` (~line 645). `observedIds = new Set(onChainIds.map(String))`. Only when `onChainIds.length > 0` (the empty branch above already returns separately — do NOT delete there).

2. **`runAllDayDetailsBackfill`** (All Day) — success path after `upsertWmcChunks` (~line 1016). `observedIds` = the union nftIds actually used to build `rows` **plus** the studio/custody nftIds, i.e. every `String(tri[0])` in `triples` (studio is already unioned into `triples` by `unionHoldingTriples`). **Gate on studio health**: only call when `!config.studioCustodyHoldings || (studio && studio.ok)`. If the custody walk degraded (`studio && !studio.ok`), skip the delete this pass (a locked moment could be missing from `triples`). Never in the `empty_scan_but_cached_holdings` or `triples.length === 0` branches.

3. **`runPinnacleDetailsBackfill`** (Pinnacle) — success path after `upsertWmcChunks` (~line 1331). `observedIds = new Set(details.map(d => String(d.id)))`. Only when `details.length > 0`. (Pinnacle has no studio/locked path, so no custody caveat.)

4. **`runPaginatedDetailsBackfill`** (mega-wallet recovery) — **only** on the full-walk complete return (`complete: true`, `nextStartIndex: null`, `hitSoftDeadline === false`). `observedIds = new Set(onChainIds.map(String))` (the `getIDs()` list is the complete id set) unioned with `args.studioTriples?.map(t => String(t[0]))`. **Do NOT** delete on the soft-deadline / partial / resumed-checkpoint exits — those have not walked the whole wallet. Same studio-health gate as #2 for the `allday` mode.

5. **Top Shot route — `app/api/wallet-backfill/route.ts`** (separate implementation). It already computes `onChainIds` and documents it (line ~319: *"onChainIds above is the wallet's COMPLETE on-chain id set"*). On the complete success path (after the upsert, before `logRun`, `terminated_reason=no_more_moments`), call `deleteUnseenWmcRows` with `observedIds = new Set(onChainIds.map(String))`. Only when `onChainIds.length > 0`. Import the helper from `@/lib/chains/flow/wallet-backfill-helpers`. If the Top Shot route has its own soft-deadline/partial-metadata exit, gate the same way — the id-set is complete at fetch time, but only call on the branch that reports the wallet fully processed.

Golazos: it opts into `flagEmptyWithCachedHoldings`, so its empty scans already log `ok:false` and won't reach a delete. Its non-empty complete path (via `runIdOnlyBackfill` or its route) gets the delete like the others.

---

## 3. Tests to add

Extend `__tests__/wallet-backfill-helpers.test.ts` and `__tests__/api-wallet-backfill-deep.test.ts`:

- **Deletes only unseen:** cached = {A,B,C}, observed = {A,B} → C deleted, A/B kept.
- **Empty observed never deletes:** cached = {A,B,C}, observed = {} → 0 deleted (assert the `empty_observed` skip).
- **Skip-cached regression pin (the 100-row trap):** a complete pass that wrote 0 rows (all cached) but observed all cached ids → 0 deleted. This is the exact `0xba1a` case; assert no deletion when observed ⊇ cached even though nothing was written.
- **AllDay locked moment kept:** observed (chain ∪ studio) includes a locked id present only via studio → not deleted; and when `studio.ok === false`, assert `deleteUnseenWmcRows` is NOT called.
- **Suspiciously-large cap:** cached = 500, observed = {1 id} → 0 deleted, `suspiciously_large` logged.
- **Partial/paginated pass never deletes:** soft-deadline exit (`hitSoftDeadline`) → helper not called.

DB-invariant angle (optional, `test:coverage` / pins): after a complete pass, `count(wmc rows for wallet+collection) == on_chain_count` for a healthy wallet.

---

## 4. Expected verification

- `npx tsc --noEmit` clean.
- `npm test` green (new tests + existing wallet-backfill suites).
- Vercel deploy reaches **READY** (check per-commit; Pro `maxDuration` cap 800s — unrelated here but don't raise it).
- Smoke: force a complete backfill for `0x0d79d58c5fe83cdc` (`POST /api/wallet-backfill-multicollection`, body `{"wallet":"0x0d79d58c5fe83cdc","skip_cached":false}`), then confirm wmc Top Shot count for that wallet drops 1159 → 1109 and `pipeline_runs.extra.unseen_deleted = 50` on the `wallet-backfill` row.

---

## 5. Guardrails (repeat every handoff)

- Commit **directly to `main`** — no branches, no PRs (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op on some paths). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0). Backticks in `-m` are command substitution — use `git commit -F` with a quoted heredoc.
- `curl` fails silently in Git Bash for Vercel REST — PowerShell `Invoke-WebRequest` only.
- CRLF: don't string-replace-patch on Windows; full-file writes or line-index edits.
- Append a `docs/overnight/ledger.md` entry (date · what shipped · revert path) in the same commit, spliced at the first `^### ` — and commit the ledger BEFORE the code so the code commit is the deploying tip.

---

## 6. Revert path

Single feature commit. Revert = `git revert <sha>` (find by message, e.g. `git log --grep="delete-not-seen"`). No migration, no DB object created, so there is no DB half to reverse. Worst case if the delete misbehaves: it removed rows that a subsequent complete backfill re-inserts automatically (the ingest re-adds any currently-held moment on the next pass), and the `suspiciously_large` cap prevents a mass wipe.

---

## 7. Optional immediate relief (proposed SQL — NOT run)

danmunroe's 50 phantom Top Shot rows will self-clear via the 14-day prune in early October. To fix his card now, after you confirm the count (his complete pass today saw 1,109), a one-off:

```sql
-- Deletes exactly the rows not seen by today's complete pass (last_seen before it).
-- Verify count first, then delete. Scoped to one wallet+collection.
DELETE FROM public.wallet_moments_cache w
USING public.collections c
WHERE w.collection_id = c.id
  AND c.slug = 'nba_top_shot'
  AND w.wallet_address = '0x0d79d58c5fe83cdc'
  AND w.last_seen_at < '2026-09-14 21:20:00+00';  -- start of today's complete pass
-- then: SELECT public.reconcile_all_saved_wallet_stats();  -- refresh his card
```

This is safe for *this* wallet because I verified those 50 ids are absent from today's complete pass — but it is the timestamp shortcut that is unsafe in general (§1), so do not generalize it.

---

## 8. End state

One commit on `main`; Vercel READY; the backfill deletes departed moments on every complete pass, collapsing the dashboard/share-card overcount window from ~14–21 days to the next backfill (minutes–hours); the 14-day `prune_stale_wmc()` stays as a backstop for genuinely-emptied wallets; danmunroe's Top Shot card reads 1,109.
