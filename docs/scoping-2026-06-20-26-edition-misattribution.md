# TopShot sales mis-attribution — investigation + remediation (2026-06-21)

**This supersedes the original "26-edition residual" scoping, which was wrong.** The 27 editions in
`topshot_conflated_editions` were not a contained class of cheap old commons — they were the only
fraction the 365-day same-serial-collision detector can see of a **platform-wide, still-active
sales mis-attribution bug**: a meaningful fraction of TopShot sales are recorded against the wrong
edition.

## How the misread happened
The guard's detector (`refresh_topshot_conflated_editions`) only flags an edition when the *same
serial* appears on 2+ nft_ids in `sales` **within 365 days**. It therefore catches a mis-attribution
only when it collides with a genuine same-serial sale in the last year. Mis-attributions onto an
edition with no matching genuine serial are invisible to it. The original doc read the detector's
output (27 editions, ~$14 avg) as the whole problem and recommended quarantining it. That buried the
real issue.

## What it actually is (on-chain verified)
A sale's `edition_id` is mis-attributed: the moment truly belongs to a different edition (usually a
different play of the **same player**, e.g. a later-series edition mislabeled, with the true edition
overwhelmingly Series-1 Base Set). Verified by borrowing **9 moments directly from their owners'
collections on Flow mainnet** (`TopShot.Collection.borrowMoment`) — in every case the on-chain
`(setID, playID, serial)` matched `wallet_moments_cache.edition_key` (wmc) and contradicted the
recorded sale edition. Examples: nft `418516` is on-chain `2:156 #1521` (Curry S1) but its sale was
recorded as `51:1862` (Curry S4); nft `36054156` is `67:2552 #856` but recorded elsewhere.

**`wmc` (wallet-walk-derived) is on-chain truth; `sales.edition_id` was wrong.**

## Mechanism (code)
`app/api/sales-indexer/route.ts` resolves nft_id → edition once, at ingest, via
`wmc → moments → GQL fallback`, and never re-resolves. So a sale permanently inherits whatever the
feeder said when it was indexed — and the feeders were/are wrong for a fraction of nfts:
- the pre-2026-05-26 `wmc`-canonicalize-trigger era corrupted ~84% of wmc keys (repaired since, but
  sales indexed in that window kept the bad edition);
- the `moments` table is itself canonically wrong for ~1,200 rows and *feeds* the indexer;
- the GQL fallback (lines ~435–445) matches TopShot's GQL UUIDs against RPC's *internal*
  `set_id`/`player_id` columns (different UUID spaces) and then builds `external_id` from GQL UUIDs,
  routing those sales onto inert **UUID-dupe editions**.

It is **ongoing**: the live `onchain` source was 5.37% wrong on recent held-moment sales; the
`topshot_gql` source was 68.7% wrong.

## Measured blast radius (held subset only — full table is larger)
Among the ~165k TS sales whose moment is still in a tracked wallet (so on-chain truth is available):
- **≥4,020** canonically mis-attributed (wrong setID/playID, both sides verified), plus thousands on
  UUID-dupe editions. The 27-edition guard surfaced ~48 colliding serials; all-time collisions were
  688 within those 27, and **1,398 across 119 editions** once true editions were consolidated.

## Remediation applied 2026-06-21 (all reversible — see revert paths)
On-chain-grounded re-key of every sale/moment whose tracked moment has an **unambiguous** int-form
wmc truth (incl. `::subID` parallels). Ambiguous cases (where wmc itself maps 2+ moments to the same
edition+serial — ~10,280 such groups exist, i.e. wmc is ~3% corrupt too) were **excluded/deferred**,
not guessed.

- `audit_20260621_remap_misattributed_topshot_sales` — **9,336 sales** re-keyed to canonical on-chain
  truth (edition + true serial). Before-state in `audit_topshot_sale_misattrib_remap_20260621`.
- `audit_20260621_revert_ambiguous_wmc_sale_remaps` — reverted **106** sales whose wmc truth was
  ambiguous; captured in `audit_topshot_sale_remap_reverted_ambiguous_20260621` (flagged for the drain).
- `audit_20260621_remap_misattributed_topshot_moments_safe` — **2,842 moments** re-keyed (only where
  the target `(edition,serial)` slot was free; `moments` enforces `UNIQUE(edition_id,serial_number)`).
  Before-state in `audit_topshot_moment_misattrib_remap_20260621`.
- `audit_20260621_remap_misattributed_topshot_sales_fn` — durable self-healing
  `remap_misattributed_topshot_sales()` (idempotent, ambiguity-guarded, service_role-only).
- `audit_20260621_guard_refresh_runs_misattrib_remap` — `refresh_topshot_conflated_editions()` now
  runs the remap before computing the guard, so the tracked set keeps converging on every cron tick.

### Revert
Each migration has a before/after audit table keyed by row id. To revert any wave:
`UPDATE sales s SET edition_id=b.old_edition_id, serial_number=b.old_serial FROM
audit_topshot_sale_misattrib_remap_20260621 b WHERE s.id=b.sale_id;` (and the analogous moments table).

## Residual (NOT fixable from DB — needs the on-chain drain)
**113 editions / 1,389 collision groups / ~2,567 colliding nfts (89% of the remainder)** are moments
held by **untracked wallets**, so DB has no on-chain truth for them. The guard honestly shows **44**
editions (365-day) and suppresses them from deal boards meanwhile.

## Remaining work (handoff)
1. **On-chain drain** (the complete fix): resolve each remaining/ambiguous nft's true
   `(setID, playID, serial)` via TopShot GQL `getMintedMoment` through `topshot-proxy` (prod only —
   the secret isn't available in a local/MCP session). Build it as an admin route on the Stage-B
   pattern, write an authoritative `nft_id → identity` map, re-key sales+moments (resolving the
   moments `UNIQUE` conflicts with that authority), then `fmv-recalc`. This zeroes the residual.
2. **Writer fix** (`app/api/sales-indexer/route.ts` + the moments hydrator): make all edition
   resolution go through on-chain truth / the authoritative map; fix the GQL UUID→edition mapping so
   new sales can't land on UUID-dupe editions; re-resolve a sale when its moment later appears in wmc
   with a different canonical edition.
3. **fmv-recalc** the ~2.4k–4k affected editions (source + target) so FMV/deal-boards/serial-premiums
   reflect the corrected sales. The normal cron sweep covers them; the force-stale cron accelerates.
4. **Detector**: keep the serial-collision detector (it's the honest "still contaminated" signal); it
   converges to 0 as the drain + self-healing complete.

## Read-only confirmation of the truth source
9/9 direct on-chain moment borrows confirmed `wmc` over `sales`. wmc's own ~3% corruption is handled
by the ambiguity guard (those rows are deferred to the on-chain drain, never guessed).
