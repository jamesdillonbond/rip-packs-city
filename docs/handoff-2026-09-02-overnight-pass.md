# RPC overnight autonomous pass — 2026-09-02 (cloud, NO-PUSH)

> ⚠ **Scope of the NO-PUSH blocker:** this is specific to **this cloud session** — it has no git
> credential and the mounted repo carries no `remote.origin.pushurl` to harvest, so `git push
> --dry-run` returns *"could not read Username for 'https://github.com'"*. **Trevor's machine and Claude
> Code push normally via the PAT in `remote.origin.pushurl`. Commit these output files as usual.**
> DB migrations and Cowork artifact repairs are NOT push-gated and would have applied this run if any
> had been clearly-safe + net-positive; none surfaced.

**Run:** `night-20260902T080327Z` · **Real time:** DB `now()` 2026-09-02 08:02:48Z (01:02 PT), app rows
07:56Z, shell agrees — no clock skew, genuine overnight window. · **Mode:** CLOUD NO-PUSH. · **Read at:**
`origin/main` 51a4d8a2 (fresh blob-filtered clone). · **Lock:** taken on the mount, released at end.

## Verdict

**Quiet, healthy night — nothing shipped, and that is the correct outcome.** Every fresh candidate is
code/route work (off-limits to the autonomous pass **and** unshippable under NO-PUSH) or was already
resolved by Claude Code. Health is GREEN save one long-standing structural breach that is draining on
schedule. Post-ship watch on the last ~48h of ships is clean; nothing auto-reverted.

## What was reviewed

- **Continuity:** ledger top matter, `metrics-latest.json`, `focus.md`, last night's lock note, and the
  fresh inbox filings since the 09-01 08:18Z pass.
- **Inbox:** 356 un-archived filings exist (back to 2026-08-09 — an archival backlog, see below). Read
  the ones filed since the last pass in full:
  - `2026-09-02T0645Z` concierge unreachable / over-throttled → **QUEUE** (route+tsx).
  - `2026-09-02T0400Z` Candy secondary now on OpenSea Solana → **QUEUE** (route + gated chain-two).
  - `2026-09-02T0330Z` lock-check-batch starving 237/249 wallets → **QUEUE** (open pipeline-targeting defect, Trevor's call; the filing itself shipped nothing and refuted its own three optimisation attempts on buffers).
  - `2026-09-02T0215Z` wmc backfill drained; partial index now 100% false-positive → **QUEUE** (drop is destructive+marginal; real lever is caller route-code).
  - `2026-09-02T0045Z` deploy-tool `verify_jwt` default hazard → **informational** (retrospective from the 00:45Z edge-fn drift sweep; already in memory).
  - `2026-09-01T0530Z` fmv-recalc historical fallback → **RESOLVED by Claude Code** (candidate-first LATERAL + property-based staleness predicate; its own post-ship watch confirms convergence).
- **Artifacts:** 11 present, none flagged broken/stale in the inbox → no repair (skill: do not regenerate working artifacts).

## Health-drift findings + deltas (vs 2026-09-01 08:05Z)

`rpc_ops_snapshot` baseline:

- **Security:** invariants / anon_write_holes / rls_off_base / secdef_anon_violations all clean `[]`.
- **Stalled pipelines:** `[]` (prior run carried the known allday-pack-opens EarlyDrop false-positive; clear now).
- **Trust health:** 1 breach — `unmapped_resolution_backlog_max = 209` (breach_at 100), **structural and
  declining** 265→228→225→**209**. `public_board_slow_count` cleared (1→0). All other 36 arms ok.
- **pipeline_fails_24h (now classified upstream-vs-own):** `offers-sweep` 36/36 = breaker working as
  designed; `ingest` 7/6 upstream. Own-failures small and chronic: `sync-nba-projections` 8 (dead sports
  proxy, #8), `wallet-backfill` 7, `wallet-backfill-golazos`/`-allday` 6 each (partial pagination fails).
  None new.
- **db_size:** 14114 → **14639 MB** (+525, normal growth). **sentinel_ts_uuid_48h:** 0.
- **FMV topshot HIGH+MED:** 8040 → **7922** (−118); `topshot_fmv_pct_stale_30d` flat at **31.7** —
  normal re-pricing churn (delete-then-insert cycles editions between confidence buckets), not a
  staleness regression.
- **Vercel prod 24h:** 31 error groups, all chronic/known — `url.parse` deprecation warning 280
  (harmless), OG/IPFS fetch `TimeoutError` 258, Top Shot GraphQL 530 41 (upstream), pack-detail /
  sniper-feed saturation statement-timeouts in single digits, AD GQL 403×4 (dead AD proxy). No new
  class, no spike, no new 500 crash. **Sentry remains dark since 08-18 (#34)** — noted, not a new event.

## Post-ship watch (previous ~24–48h) — ALL HOLDING

| ship | check | result |
|---|---|---|
| `e376ccae` parity commit (recovered fileless migration 20260901071258) | production behaviour | docs/file only; DB object pre-existed; nothing to regress ✓ |
| ops_snapshot `pipeline_fails_24h` classifier (09-01 evening) | is it classifying | WORKING — `upstream` field populated, own-failures ranked above 530s ✓ |
| fmv-recalc predicate fix (Claude Code) | did it converge, not re-timeout | 37 runs/6h, 2 transient fallback errors (not 100%), max `historical_fallback`=54; backlog drained ✓ |
| wmc backfill drain (Claude Code, 152 rows) | fillable_now | 0 per filing; idempotent forward-only fill ✓ |

Nothing auto-reverted.

## Shipped

**Nothing.** No clearly-safe + net-positive DB migration or artifact repair surfaced, and code/deploys
are unshippable under NO-PUSH.

## Queued for Trevor / Claude Code (needs a push, a product call, or is off-limits)

1. **Concierge distribution + throttle** — `SupportChatConnected` is mounted on 10 pages, absent from
   `app/insights/layout.tsx` and all ~30 `/insights/*` boards, home, `/edition/[id]`, `/early-access`.
   2,704 insights sessions/30d had no launcher. Separately, signing in *reduces* the concierge allowance
   from 40/hr to 5/day. 0 real (`is_smoke_test=false`) conversations since 2026-08-16. The bot is
   healthy; the constraint is distribution. Route+tsx change → needs a push.
2. **`lock-check-batch` fairness defect (OPEN)** — 48/48 ok, full designed rate, yet serves **12 of 249**
   hot wallets (69% of checks to one wallet). Cause: 1,474,231 `lock_checked_at IS NULL` rows all tie
   under `ORDER BY lock_checked_at ASC NULLS FIRST`, so the scan's input order decides targeting forever;
   `p_max_age_days` is inert. Fix = an `is_user_wallet` priority tier. Three flat rewrites were refuted on
   buffers (live per-wallet LATERAL = 21,725 buffers vs 631,906 / 565,784) — **do not re-derive them; the
   live shape is best.** Pipeline-targeting route code, Trevor's call.
3. **`idx_wmc_metadata_fillable` is 100% false-positive** — after the 152-row drain it admits 63,283 rows,
   0 fillable (a partial index cannot test the editions-join right side). ~185 buffers/call of scan, no
   selectivity. Real lever is caller route-code (gate or stop the per-wallet backfill call, ~4,000/day of
   pure overhead). A `DROP INDEX` is destructive + marginal and removes future utility when new
   NULL-bearing rows arrive → decision, not an autonomous ship.
4. **Candy secondary now trades on OpenSea Solana** (Candy a named launch partner, ~2026-08-31; "live now"
   is Candy's own claim, treat as imminent). Every Candy market surface (`candy-sales-indexer`,
   `candy-listings-indexer`, `ingest/candy-offers`) is Magic-Eden-only; `count(distinct marketplace)=1`
   across all Candy sales ever. OpenSea Candy trades captured nowhere. New ingest source = route code +
   gated (chain-two).
5. **Sentry dark since 08-18 (#34)** — client-only failures captured by nothing; the E2E DOM Smoke badge
   is the entire detection surface. Not paying is Trevor's call.
6. **Inbox archival backlog** — 356 un-archived filings back to 08-09. Archival is a git commit, which
   NO-PUSH cloud nights cannot land, so the pile grows. A push-capable run (Claude Code / desktop) should
   `git mv` consumed filings into `docs/overnight/inbox/archive/` and commit.

   > 🚨 **DO NOT ACT ON THIS ITEM AS WRITTEN — it conflicts with `inbox/INDEX.md`, which is the more
   > specific authority and says the opposite.** Checked by a push-capable Claude Code session on
   > 2026-09-02 ~14:15 PT, which was in a position to do it and deliberately did not.
   >
   > INDEX.md's own header: *"Archiving by date was considered and **rejected**. The
   > `rpc-nightly-autonomous-pass` task DRAINS this directory: moving a filing that was never acted on
   > would silently remove it from that queue, and nothing would ever surface it again. A date is not a
   > drained-determination, and **no per-item drained state exists to read**. **Archiving is Trevor's
   > call, not a chore.**"*
   >
   > ⭐ **The item's own qualifier is the unexecutable part.** "`git mv` **consumed** filings" is exactly
   > right — and there is no way to determine which are consumed. The only mechanically available
   > interpretation is *by date*, which is the one that was explicitly rejected, and "356 filings back to
   > 08-09" invites precisely that. **An instruction whose only executable reading is the forbidden one
   > will eventually be executed.**
   >
   > ⚠ Archiving is also not a pure `git mv`: **`INDEX.md` carries 4 CI assertions, two of them COUNTS**,
   > so archiving a filing means deleting its INDEX entry in the same commit or CI reds
   > (`__tests__/inbox-index-lists-every-filing.test.ts`). `docs/overnight/inbox/archive/` already exists;
   > the directory is not the blocker.
   >
   > 👉 **What would actually unblock this: a per-item drained marker** — a front-matter line or a
   > trailing `## Drained <date> — <what shipped>` section that a pass writes when it acts on a filing.
   > Then archiving becomes mechanical and safe instead of a judgement call nobody can make from a date.
   > Until that exists, this stays Trevor's.

## Failed / blocked / reverted

None. No verification failure; production shipping was never engaged (nothing was eligible).

## Continuity writes this run

`metrics-latest.json`, this handoff, and a ledger entry were written **to the mounted tree** (the durable
store future runs read). Under NO-PUSH they are **uncommitted** — a push-capable run should commit them.

> ✅ **DONE — committed as `ca4e8b63e`** ("commit the 2026-09-02 cloud pass's continuity writes, which
> NO-PUSH stranded on the mount"). Verified 2026-09-02 ~14:15 PT; no action left on this paragraph.
Inbox filings were left in place (not moved) to avoid a large uncommitted churn on Trevor's working tree;
see queued item 6.
