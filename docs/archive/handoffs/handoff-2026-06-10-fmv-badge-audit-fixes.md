# Handoff — FMV writer guards + badge catalog-walk + tree cleanup — 2026-06-10

Context: the 2026-06-09 all-user FMV/badge audit (docs/audits/fmv-badge-all-user-audit-2026-06-09.md, in this commit) found four failure classes. Cowork already shipped the DATA repairs live: migrations audit_20260609_repair_portfolio_top_poisoned_fmv (41 editions, sales-median based) and audit_20260610_repair_pass2_anchor_to_live_book (26 editions anchored to the live TS book after dapper.market verification), plus wmc drift-sweeps for all 23 user wallets (145,952 rows checked, 0 drifted after; both copies of Trevor's 2:202 Jokic now $6.00, matching dapper's live $5.30 floor). Scratch tables audit_lt_user_top100 / audit_lt_livetoken_rows / audit_fmv_repair_candidates exist (service-role-only) and are still needed by the scheduled LiveToken re-check — do not drop yet. This handoff is the WRITER fixes so the poison can't come back, the badge coverage rebuild, display fixes, and clearing the pending uncommitted tree in VS Code. Last known pushed HEAD: acf85c0.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

ITEM 0 — Clear everything pending in the VS Code working tree (FIRST, Trevor asked for this explicitly)

From the Cowork sandbox the tree shows ~80 modified files with a diffstat of 73 files changed, 67 insertions(+), 2238 deletions(-) — that deletion mass across files like components/TopNav.tsx and app/layout.tsx looks like the known Windows-mount stat-dirty/corruption view (see memory rpc-mount-corruption-tooling), NOT necessarily real edits. Cowork deliberately did not stage or commit anything (cross-session git add -A hazard). Do this natively:

1. Run node scripts/check-tree-corruption.mjs (it exists; check-brand-tokens.mjs sits next to it). If corruption is reported, recover corrupted files via git show HEAD:<file> > <file> per docs in memory git-state-recovery before anything else.
2. Inspect git status and git diff per file. Commit the INTENDED work in logical commits and push to main. Known-intended untracked files to include: docs/audits/fmv-badge-all-user-audit-2026-06-09.md, docs/handoff-2026-06-10-fmv-badge-audit-fixes.md (this file), docs/handoff-2026-06-10-pinfmv-drift-guard-false-positive.md, docs/handoff-2026-06-10-sitemap-fossil-editions.md, docs/handoff-2026-06-10-wmc-fifth-call-site.md, the docs/overnight/inbox/2026-06-10T*.md monitor drops, and the modified docs/overnight/ledger.md + focus.md + CLAUDE.md if their diffs are real edits (eyeball them).
3. If a modified source file's diff is pure deletion/truncation with no plausible author, restore it from HEAD instead of committing it.
4. Verify clean: git status empty, git rev-list --count origin/main..HEAD returns 0 after push.

Revert: per-commit git revert; restored files carry no risk.

ITEM 1 — fmv-recalc thin-window outlier/serial guard (kills the $9,000 Jokic class)

File: app/api/fmv-recalc/route.ts (exists, verified).

Root cause measured live: edition 2:202 (circ 3,525) had its 30d window roll down to two sales — $6 and a $9,000 serial-#1 grail sale — and the WAP let the grail sale own the edition price ($8.60 MEDIUM -> $9,000 LOW on 2026-06-06, re-stamped daily). 18 editions in users' top-100s hit this class. No outlier rejection can work at n<=2 by construction, so the fix is structural:

- In the main per-edition pricing step, when the 30d window has fewer than 5 usable sales, extend the window to 90d for that edition (keep recency weighting if present).
- Before computing WAP, drop sales with price > 5x the edition's trailing 90d median when the window has >= 3 OTHER sales; if the window is so thin that dropping leaves < 2 sales, cap the computed FMV at 3x the trailing 90d median instead of publishing the raw WAP.
- Exclude dust (price < $0.50) and impossible serials (serial_number > circulation_count when both known) from every window — the audit found both polluting medians. The existing F3 impossible-serial guard covers some paths; make sure THIS path has it.
- A serial-#1 / jersey-serial sale must never set edition-level FMV: if the window's max sale came from serial <= 10 (or serial = jersey number when known) and is > 3x the rest-of-window median, exclude it.

Verified counts: the audit's platform-wide sizing — of 4,971 TS editions with 5+ sales in 90d, 63 had latest FMV > 3x their own sales median, 15 > 10x (read-only queries in the audit doc). Expect both numbers to drop near zero within a couple sweep cycles after deploy.

Revert: git revert of this commit; the audit-repair snapshots stay valid either way.

ITEM 2 — topshot-fmv-populate sales-precedence + troll-ask guard (kills the $550 Fit Check class)

File: app/api/topshot-fmv-populate/route.ts (exists, verified — algo tag topshot-gql-v1).

Root cause measured live: 102:3519 sat at $4.25 LOW (real sales), then on 2026-06-07 this feed stamped $550 ASK_ONLY from a troll ask (550 = ask x 0.9), and Step 6 carried it forward daily. The marketplace-feed path has no sales-precedence check — the cold-tail path (fmv-recalc Step 5b per the 2026-06-07 TS-NO_DATA-troll-asks decision) already refuses to ASK_ONLY zero-sale editions, but THIS path bypasses that decision.

- Before writing an ask-derived value for an edition, read the edition's latest sales stats (90d count + median — cheapest is to reuse whatever the route already fetches, else one indexed query). If the edition has >= 3 sales in 90d, do NOT write ASK_ONLY over it; skip, or clamp the written value to min(ask*0.9, 3x sales median) and keep the sales-derived confidence.
- For zero/thin-sales editions, sanity-gate the ask against badge_editions context if available (e.g., refuse asks > 10x avg_sale_price when avg_sale_price exists).
- Write top_shot_ask into the snapshot row so downstream surfaces can show "ask-based" honestly (column exists).

Verified: dapper.market live book matched badge_editions.low_ask exactly on all 3 browser spot-checks (Tatum Honors $19, LeBron Throwdowns $499, LeBron Base $22.40) — the internal ask feed is a faithful mirror of the live book, so ask-anchored pricing is fine; UNCORROBORATED single asks are the hazard.

Revert: git revert.

ITEM 3 — fmv-recalc Step 6 stale-touch must stop refreshing ask-derived/poisoned rows

File: app/api/fmv-recalc/route.ts, Step 6 (the latest-CTE re-stamp; see CLAUDE.md 2026-05-30 Step 6 entry).

Currently Step 6 re-stamps any latest snapshot != NO_DATA whose computed_at is > 24h old, refreshing computed_at on LOW and ASK_ONLY rows — that's what made the $9,000 and $550 immortal AND hides true staleness from every freshness metric. Change the filter to only touch confidence IN ('HIGH','MEDIUM') rows (or at minimum exclude ASK_ONLY and any algo_version LIKE 'audit-repair%' / 'topshot-gql-v1%'). LOW/ASK_ONLY editions should age visibly until a real recompute reprices them.

Revert: git revert.

ITEM 4 — badge-sync catalog-walk mode (fixes 34% coverage)

File: app/api/badge-sync/route.ts (exists, verified — currently sources searchMarketplaceEditions by badge-tag ID).

Root cause: marketplace search only returns marketplace-active editions, so badge_editions covers 3,138 of 9,136 canonical TS editions; 593 of the 1,201 editions in users' top-100s have no badge row at all (49%), and per-wallet "no badge data" runs 11-99%.

- Add a catalog-walk pass: iterate canonical editions (editions WHERE collection_id = TopShot AND external_id ~ int-pair) in batches, resolve via searchEditions by set/play UUID (the proven path from the editions catalog) or per-set GQL, and upsert badge rows with play.tags / setPlay.tags / circulations (circulationCount, burned, locked, ownedByCollectors). Reuse this route's existing normalization + the play_tag allowlist semantics downstream (do NOT widen the 9-badge allowlist).
- Cursor it (pipeline_runs extra) so it sweeps the full catalog over several daily ticks; the marketplace-tag pass stays as the freshness layer for asks.
- Watch the maxDuration 300 budget; batch + fire-and-forget after() if needed (CRON-30S discipline).

Expected metric: badge_editions TS coverage 3,138 -> ~9,136 over the sweep; the audit doc's "no badge row" count per top-100 drops to ~0. Also unlocks Item 6.

Revert: git revert; new rows are additive.

ITEM 5 — wmc-fmv-populate drift-sweep mode (fixes the 22.5% display drift)

File: app/api/wmc-fmv-populate/route.ts (exists, verified).

The denorm loop leaves wmc.fmv_usd stale for long stretches — the audit found 518/2,300 top-100 rows displaying a value >±25% off the live snapshot (same edition $9,000 and $3.30 inside one wallet). Add a bounded drift-sweep pass each tick: for allow_list-active wallets (small set), rewrite rows where wmc.fmv_usd deviates >25% from the latest snapshot. Keep it scoped/chunked — full-table rewrites are the DBSAT wmc-rewrite-storm class (see docs/handoff-2026-06-10-dbsat-wmc-rewrite-storm.md if present; coordinate, don't duplicate). Cowork's one-time sweep already converged the 23 wallets; this keeps them converged.

Revert: git revert.

ITEM 6 — display honesty + small data fixes (frontend, fast)

- Portfolio/dashboard top-N (app/dashboard/page.tsx + the collection page top-holdings sort): down-rank or visibly caveat ASK_ONLY and LOW values ("ask-based / thin data") so an ask-derived number can't silently crown a portfolio. The audit's core insight: bad values SORT TO THE TOP — selection bias makes rare errors maximally visible.
- Team-moment editions (e.g. Clamps 98:31xx, Fit Check 102:35xx) have player_name NULL — render team_name or the edition name's team part instead of a blank (dapper titles these "Miami Heat Reel").
- Circulation display: where badge_editions.effective_supply exists, show it (or "x/y, z burned") instead of raw circulation_count — dapper shows /1125 where RPC shows /1500 (Clamps), /1000 vs /1149 (Flagg). After Item 4 lands, effective_supply exists for everything.

Revert: git revert per commit.

ITEM 7 — investigate sales->edition mis-attribution (the bimodal S1 clusters)

Evidence: 2:202's history holds a $189-259 cluster that matches sibling 2:37's price level while its real book floor is $5.30; conversely 2:244 / 2:2 / 11:151 / 11:153 carried cheap-sale medians ($2-31) wildly below their corroborated books ($23 / $45-49 / $499 / $31). Both directions smell like sales rows keyed to the wrong edition (suspects: the UUID-dupe merge era, or GQL feed attribution). Pick 5-10 sales from each suspicious cluster (tx hashes in the sales table; the $9,000 one is ce1d66ecdd1e24d434b3af329c39a7269bee34b7c4c7659aa46d9e407d3b624c) and decode via Flow REST /v1/transaction_results through spork-proxy if historical — confirm the moment NFT id's real edition. If mis-attribution is confirmed, scope the contaminated window and plan a re-key migration (hand the DB half back to Cowork). This is the deepest root cause — the writer guards in Items 1-2 contain the damage either way.

Revert: investigation only; any re-key ships separately.

Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher silently ERRORs the deploy.
- CRLF: no string-replace patches; full-file writes or findIndex on split lines.
- npx tsc --noEmit clean before each push; smoke test green after deploy; deploy must reach READY.

Expected end state: working tree clean and pushed (Item 0); commits on main for Items 1-6 with deploys READY; fmv-recalc no longer publishes single-grail-sale or carried-ask values (over-3x-median count ~0 within 2 sweep cycles); badge coverage sweeping toward 9,136/9,136; user-facing portfolio tops show book-plausible numbers with honest confidence labels; Item 7 verdict recorded in docs/.
