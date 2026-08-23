# RPC deep audit — run 3 · 2026-08-22

Pass ran 09:20–11:05 PT (16:20–18:05Z). Six parallel sweeps (security, pipelines, data integrity, rendered DOM, codebase, growth) plus a lead re-verification of the register.

**Nothing was shipped. That is a decision, not a failure to act — see "Why this pass shipped nothing".**

> ## ⚠ ADDENDUM — 2026-08-22 18:40 PT (2026-08-23 01:40Z), ~8 h after the pass
>
> A concurrent Claude Code session worked the same artifacts through the afternoon. Re-measured state, and three things changed materially:
>
> **1. Handoff §7 was HALF-EXECUTED, and the half that shipped is the one carrying the cost.** pg_cron jobids 60 and 4 were moved to `10 23` / `25 23` — exactly the recommended schedule — but migration `20260822013000` is **still not applied**, and §7 said the order was load-bearing. Measured: **jobid 60 succeeded in 347.2 s**, i.e. ~5.8 minutes of `ACCESS EXCLUSIVE` on a table backing a public crawlable page, at 4:10 PM PT — the top of the migration's own 105–350 s range, and precisely the trade the migration exists to remove. **jobid 4 still failed** (300.0 s statement timeout), so the overlap mat's freshness came from some other path, not the move. `cross_collection_cohort_mat` is now **2.4 h** fresh (was 132.3 h) — real progress, bought at a daily afternoon reader stall. **Applying the migration in tomorrow's 13:00–17:00 PT window collapses the lock to milliseconds and is a 30-second job.** R14 remains unpinned (0 of 2) despite 19 migrations landing today, so that batching chance passed too.
>
> **2. A filed finding's remedy is INVERTED — the second instance today.** `docs/overnight/inbox/2026-08-23T0025Z-…` reports `/api/ready` 500ing for 8 days because `anon` lost EXECUTE on `health_check()`, and its residual hypothesis ("a blanket revoke took it as collateral") implies restoring the grant. **Reading what the function returns — which that filing did not do — inverts the conclusion.** `health_check()` returns `auth_users`, `active_7d`, `user_profiles`, `saved_wallets`, `allow_list`, telemetry counts and `db_size_mb`; `app/api/ready/route.ts` uses the ANON key and returns `{ ...data, … }`, spreading the whole payload; and `/api/ready` is anon-reachable via `PUBLIC_READ_APIS` (`proxy.ts:718`). **Until 2026-08-15 an unauthenticated GET published Trevor's user and wallet counts and DB size to anyone on the internet. The revoke is the fix, not the defect — do not restore the grant.** Exposure is bounded: `/api/ready` is the only live caller (`app/api/health/route.ts` is a static stub whose `health_check` mention is a stale comment). Filed as **R44** with the correct fix. ⚠ Live consequence meanwhile: the thin-volume caveat has not rendered on `/[collection]/market` or `/[collection]/analytics` for 8 days.
>
> **3. Two more filings folded in as R45 (Golazos offers Series 2/3 filters that can only return nothing — verified 575/0/0, but do NOT delete the rows: both instruments read the same contract and are blind to a second one by construction) and R46 (the saturation is STRUCTURAL — 8,227 GB read in 10d18h with `dealloc = 0`, and 1,171 hours of execution in 258 hours of wall clock ⇒ ≈4.5 backends busy at all times on 2 cores; nothing has to go wrong for this instance to be saturated).**
>
> **Also:** the concurrent session closed **R32** and marked **R6 REFUTED IN PART** — it could not reproduce either half in the healthy window (all 5 collections 200 in 0.97–8.7 s) and records that the loading skeleton handoff §3 asked for **already exists**. That contests my §3, honestly: sweep D observed the failure in-band under a real outage, the other session measured out-of-band. Both readings are window-dependent, which is the point — R6 now carries "re-measure in-band". Register table integrity was also repaired: two rows had unescaped `|` inside code spans, which breaks the render (165 body rows, 0 width mismatches after).

---

## The one number that matters

**21 users · 0 WAU · 0 new signups in 7 days · 5 `wallet_paste` in 7 days.** Newest signup 2026-08-08, newest sign-in 2026-08-14. Unchanged since 08-18. Per the standing gate, that is the CORRECT state — accuracy is the gate and the product is not being promoted.

⚠ **But the instrument that looks like it disagrees is measuring machines.** See D-A8.

---

## Why this pass shipped nothing

Three constraints composed, and each was checked rather than assumed:

1. **`git push` is unavailable from this sandbox.** `git push --dry-run origin main` → `fatal: could not read Username for 'https://github.com'`. Diagnosed from the error string, not from the fact that it failed. Every code fix below is therefore a handoff by necessity, not by choice.
2. **The local clone is 134 commits behind `origin/main` and dirty.** Every code claim in this document was derived with `git show origin/main:<path>` / `git grep origin/main`. No line number is quoted from the working tree; symbols are cited instead. This is load-bearing: **11 of the register's OPEN items turned out to be already fixed inside those 134 commits**, and a sweep reading the working tree would have re-filed all of them.
3. **Every DB change available was either a no-op, security-neutral, or carried an explicit written instruction to wait.** Detail:
   - Two of the three committed-but-unapplied migrations (`20260820190000_..._snapshot_prune_log_tables`, `20260821021000_..._snapshot_retention_purges`) are **provenance snapshots whose headers say DO NOT APPLY** — byte-identical to live, so applying them buys nothing and costs a ~10–20 s burst of user-facing `PGRST002` 500s.
   - The third (`20260822013000_..._cross_collection_refresh_lock_window`) is genuinely ready and fixes a live P1 — **but its own header says "apply in the healthy window (20:00–00:00Z), not in the 01:00–19:00Z degraded band."** This pass ran at 16:20–18:05Z, inside the degraded band. Overriding a written window instruction to save three hours, on an instance whose repeated recorded mistake is *adding load during saturation*, is not a trade worth making.
   - R14's two `ALTER PROCEDURE … SET search_path` statements buy **zero** exposure reduction (both are `prokind='p'`, `prosecdef=false`, and `has_function_privilege` is false for both `anon` and `authenticated`) and would pay the same schema-reload burst. They stay batched for the next real DDL window, as run 2 also decided.

**Security posture is clean and was re-derived, not inherited:** `check_public_security_invariants()` 0 rows · `check_anon_write_surface()` 0 rows · `jsonb_array_length(check_secdef_anon_exec_drift())` 0. RLS 0 tables uncovered. 0 anon-readable views missing `security_invoker`. 0 anon/auth-readable materialized views.

---

## P0

### D-A1 · D12 has RECURRED on a second surface: the public Top Shot analytics tab publishes a 99-day-old single row as market depth · VERIFIED (by the lead, not inherited)

`/nba-top-shot/analytics` renders **"ORDER BOOK DEPTH · 1 listings · MEDIAN ASK $5.0k · P90 ASK $5.0k"** to anonymous visitors.

Measured directly: `ts_listings` holds **exactly 1 row**, `max(ingested_at) = 2026-05-15 14:43Z`, **99.1 days stale**. The sampler was retired 2026-05-26.

**Why it survived D12.** D12 was closed on `components/analytics/ListingsDashboard.tsx`, which now correctly states in-place that the source "was retired 2026-05-26 and its last row was written on 2026-05-15, so no orderbook depth is shown here." That fix never reached `OrderBookCard` in `app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx`, which reads the same `topshot_orderbook` leg of `analytics_listings_summary` and renders it. **This is the documented "fix per PANEL, not per page" failure, and the copy-paste spread the honesty canon warns about — the register recorded D12 as RESOLVED with a revert path, and it was resolved on one of two surfaces.**

**A FOURTH STATE nobody modelled.** `OrderBookCard` is *well* hardened for the failure case — it has an explicit `failed` branch and a comment naming the honesty class. It handles read-failed, read-ok-empty, and read-ok-populated. It has no concept of **read-ok-but-the-source-is-retired**, so `count === 0` is false and the stale row renders as a market statistic.

⚠⚠ **THE OBVIOUS DB-SIDE FIX MAKES IT WORSE — do not take it.** Nulling the `topshot_orderbook` leg in `analytics_listings_summary` looks like the clean server-side repair. But the card reads `orderbook?.count ?? 0` and branches `count === 0 → "No live listings."` — so the RPC fix would publish **"No live listings"** for a collection carrying **12,259 live `low_ask` rows** in `edition_offers`. Both branches lie; only the component can tell the truth. This is why the fix is a handoff and not a migration.

**Two more surfaces carry the same retired-sampler claim in the present tense:**
- `lib/analytics/methodology.ts` (`listings.paragraphs[1]`): *"Top Shot orderbook depth is sampled to roughly 100-200 listings on each scan"* — public methodology page, present tense, about a sampler dead for three months. This is the exact stale-disclosure string D12 was filed on. **A stale disclosure is worse than none.**
- `app/(analytics)/analytics/listings/page.tsx` metadata `description`: *"a periodically-sampled snapshot of the Top Shot marketplace orderbook"* — in the indexed SEO description.

Fix is specified in the handoff, §1.

---

## P1

### D-A2 · `/insights/candy-mlb` SPREAD panel publishes a failed read as a market fact, with its own contradiction on screen · VERIFIED (rendered DOM)

The page's banner reads: *"PARTIAL DATA: 6 of 10 sections could not be loaded (Pack market, **Offer spread**, Serials, Scarcity, Players, Parallels). This is a temporary database-load failure, not an empty result — treat the affected sections as unknown rather than zero."* ~200 px below, the SPREAD tab carries a badge of **0** and reads **"No offers or asks yet."** The MARKET tab on the same page independently reports **"WITH A BEST OFFER: 26"**.

The page already knows the read failed and names Offer spread specifically. The banner is the best instance of the honesty canon on the site; the panel is the un-hardened one. Per-panel fix.

### D-A3 · `get_collection_stats` is failing on 4 of 5 public collection landings, and the honest error takes ~110 s to arrive · VERIFIED (rendered DOM, anonymous)

`/nba-top-shot/overview`, `/nfl-all-day/overview`, `/laliga-golazos/overview`, `/ufc/overview` all end at *"Couldn't load collection stats right now"*. Only `/disney-pinnacle/overview` returns data. **The copy is honest — this is an availability finding, not an honesty one.** Register item **R6**, still open.

The renderable defect is the first ~110 s: the three KPI boxes render as **empty labelled boxes with no value, no em-dash, no skeleton and no banner**. These are the pages the marketing home links to.

### D-A4 · Large public entity pages intermittently return an unbranded Next.js 500 · VERIFIED (screenshots both sides)

`/nba-top-shot/set/base-set` and `/nba-top-shot/team/los-angeles-lakers` both returned the bare *"This page couldn't load — A server error occurred."* (title `500: This page couldn't load`), then rendered correctly on retry. Both are linked **directly from the public `/nba-top-shot/overview` catalog**. Small siblings (`/set/heat-check`, `/team/washington-mystics`) never failed — consistent with a heavy read blowing its budget under the same DB load driving D-A3. Every other public surface degrades honestly and in brand; these bail to Next's default error page.

### D-A5 · The whole `*-sales-history-backfill` family is throttled off by its own saturation breaker and is invisible to every failure instrument · VERIFIED

Each of the 9 history backfills opens with a saturation circuit-breaker that returns `{"skipped":"saturation","recent_fails":N}` **and logs `ok: true, rows_written: 0`**. Because `ok` is true, `v_pipeline_failure_rates` reads **0%** and `detect_stalled_pipelines` sees a terminal row on time. **A fully-throttled pipeline is byte-indistinguishable from a caught-up one.**

48h to 2026-08-22 16:40Z, n=190 runs across 9 pipelines: **125 of 190 ticks (65.8%) skipped for saturation**; total `rows_written` across all nine = **315**, all from `pinnacle-sales-history-backfill`; **the other eight wrote zero rows in 48 hours.** `recent_fails` at the newest tick: topshot 154 · pinnacle-studio 163 · golazos-studio 155 · allday-studio 156 · ufc 155 · golazos 152.

⚠ INFERRED sub-claim: the breaker may not decay, because a skip logs `ok:true` and so cannot retire the `recent_fails` it counts. **Refuted if** `recent_fails` on any arm falls materially during a quiet 20:00–00:00Z hour.

**This also settles register item R17** — but not by the refutation condition R17 named. The two 40,000-block/zero-decode backfills no longer scan at all; every recent tick returns `{"skipped":"saturation"}` in 0.7–29.7 s **before** any block scan. Neither R17 branch describes production. Close R17; do not action its recommendation.

### D-A6 · 29 of 67 deployed edge functions have no committed source, and the credential guards are blind to all of them · VERIFIED (set diff, not count diff)

**67 deployed · 38 committed · 0 committed-but-not-deployed ⇒ exactly 29 with no repo source.** (Repo half re-verified by the lead: `git ls-tree -d origin/main supabase/functions/` = 38 dirs excluding `_shared`.) **21 of the 29 are `verify_jwt: false`** — publicly invokable with auth that cannot be read from the repo.

The hardcoded-credential grep and `__tests__/edge-fn-no-hardcoded-gate-keys.test.ts` both derive their file set from `supabase/functions/**`, so **43% of the fleet is outside the guard by construction** — the documented "a guard's own derivation fixes its blast radius" defect.

**Proven by example, not theory:** commit `b70d4582` (2026-08-18) found `resolve-allday-rip-dist-api` — a member of that set — deployed with a literal `const GATE` as the sole auth on a service-role writer. ⚠ `compute-achievements` is also in the uncommitted set and `verify_jwt:false`; it is the callee of R13's now-gated POST, so the Next.js side is fixed while the edge function's own auth remains unauditable from the repo.

### D-A7 · Cross-collection mats 132.3 h stale under a "REBUILT DAILY" label · VERIFIED · night 4

`cross_collection_cohort_mat` `computed_at` **2026-08-17 04:10:00Z**; overlap mat 04:25:00Z. At `now()` that is **132.3 h (5d 12h)**, up from 4d19h in the 08-21 escalation — escalating at 1 h/h with no self-heal. pg_cron jobids 60 and 4: **4 succeeded (latest 08-17), 6 failed (latest 2026-08-22 04:10Z/04:25Z)** — six consecutive daily `statement timeout`s inside the `INSERT INTO public.cross_collection_*_mat`.

The rendered page states **"COHORT DATA COMPUTED AUG 16, 2026, 9:10 PM PDT · REBUILT DAILY"** — 6 days stale under a daily promise. ⚠ Note the split verdict: the *board* tells the truth about its own age (`FreshnessStamp` reads the mat's own instant, and all three API legs return `boardUnavailable(...)` on error), so this is a **pipeline failure plus a stale cadence label**, not a fabricated number.

**The fix exists and is committed but unapplied** — see the handoff §7 for the exact two-step recipe. It is the single highest-value operator action available.

### D-A8 · `funnel_events` view volume is ~100% machine traffic, and nothing on the table says so · VERIFIED (independently reproduced by the lead)

7 days to 2026-08-22 16:30Z: **15,803 events across 15,689 distinct sessions.** Only **53 sessions (0.34%)** fired more than one event. **99.82%** of rows carry a null referrer. `getSessionId()` persists `rpc_sess` in `sessionStorage`, so a real multi-page visit shares one id — 1.007 events/session is a crawler with fresh storage per fetch, not browsing. URL distribution is breadth-first enumeration (6,849 hits across 6,176 distinct edition URLs). Positive control that the instrument *can* see a real session: `max_events_per_session = 12`.

**Why it matters:** `collection_view` rose **82 → 7,738/day** between 08-16 and 08-18 with **zero** change in `wallet_paste`, signups or sign-ins. There is no bot flag on the table. Any future reading of "views" as traction will be wrong by roughly three orders of magnitude. This is the `is_smoke_test` lesson in a new table: **slice by the synthetic/real flag before slicing by time — except here the flag does not exist yet.**

### D2b / gate-key rotation · UNCHANGED, staleness grown · Trevor's

Independently re-derived against the `e66884f79` boundary; every figure in the 08-18 blocker filing reproduces to the minute. Six functions' secrets remain **INERT**, so rotating their crons would 403 every tick: `ingest-allday-pack-opens` 14.9d · `ingest-topshot-pack-opens-history` 15.0d · `ingest-pinnacle-mints` 23.7d · `compute-golazos-pack-ev` 35.0d · `backfill-pack-opens-api` 11.7d · `backfill-allday-pack-supply` 11.7d.

Operational corroboration independent of any timestamp: `net._http_response` 2026-08-22 10:34–16:34Z, n=663 → **0×403, 0×401**; all six pipelines healthy in 72h. The deployed code still accepts the un-rotated key.

---

## P2

| id | finding | evidence | label |
|---|---|---|---|
| D-B1 | **`/api/pack-ev` POST lets an unauthenticated caller set the persisted pack price, the EV denominator and the +EV verdict** — R2's sibling; the R2 fix did not generalise. `proxy.ts` opens it to anon `POST` in the same block R2 lived in; `computeDualPrice()` takes `requestedPrice` from the body and a SERVICE_ROLE client inserts it into `pack_ev_history` | 30d, n=111,736 rows / 3,852 packs: caller-influenced path exercised on **25 rows (0.022%)**, all at `pack_price = 10.00`; packs with >1 distinct primary/min price = **0**. Not being abused. ⚠ `gross_ev`/`pack_ev` are clamped; **`pack_price` is not** | VERIFIED latent |
| D-B2 | **8 new `rpc_thp_leg_*` pg_cron jobs have zero `pipeline_runs` observability**; `rpc-thp-leg-impossible-parallel` is at **8 failed / 24 runs = 33.3%** over 7d | `prosrc ~* 'log_pipeline_run'` false for all 8; `pipeline_runs where pipeline ilike '%trust%'` = 0 rows in 48h. Held at P2 because the reader-side guard exists — precompute metric ages are ≤ 9.8 h and `v_rpc_trust_health_freshness` surfaces them | VERIFIED |
| D-B3 | **`job startup timeout` is 67–80% of all pg_cron failures** (`max_worker_processes = 6` vs `cron.max_running_jobs = 32`); a startup timeout writes **nothing** to `pipeline_runs`, so it is pure invisible tick loss | 08-12→08-22 daily: 11/42/154/123/67/151/332/77/268/224/162 against ~4,000 dispatches/day = 1.7–8.3%. Spread across 25+ jobs, not concentrated. **Already filed today** in `inbox/2026-08-22T1600Z-…`; re-derived independently over a longer window | VERIFIED |
| D-B4 | `wallet-backfill*` drops ~100k wmc rows/day to upsert-chunk failures, dominant first error `Timed out acquiring connection from connection pool` | 08-20 113,249 · 08-21 90,779 · 08-22 74,062 (partial); flat by 6h bucket, no trend. ⚠ **Not permanent loss** — these re-walk on the next tick. The cost is redundant IO on an IO-throttled instance. ⚠ Do not compare to the 08-17 "≈1,400/6h" figure: that was one pipeline, this is the 7-pipeline family | VERIFIED |
| D-B5 | **`scripts/` is outside the `.range()`-requires-`.order()` ban by construction** — the ratchet's `ROOTS` are `app,lib,supabase/functions,workers`. 10 unordered pagination sites. Sharpest: `scripts/backfill-livetoken-fmv.mjs` pages `fmv_snapshots` unordered to build the `existingIds` **skip set**, then runs `.delete()` + `.insert()` on `fmv_snapshots` — a pagination omission there is an unrequested FMV overwrite | Positive control: the ratchet's own detector re-implemented verbatim returns **0** on its declared ROOTS, so the guard is honest about its scope. `components/` = 0. Extension blind spot empty | VERIFIED |
| D-B6 | **`docs/overnight/inbox/` has not been archived since 2026-08-13; 168 live files, 9 days deep** — drained and open are now indistinguishable | 441 total inbox paths at origin/main, **168 live**, archive newest `2026-08-11T2112Z`. ⚠ This audit's own brief estimated "~29 files" — **off by 5.8×**, which is itself the evidence that the signal degraded silently. It breaks cheap-check (1) of the audit protocol | VERIFIED |
| D-B7 | **The homepage promises "moment ID" three times and the submit path cannot resolve one, then blames the user.** `WalletSearch`'s default placeholder is the only one not overridden, and `HomePageMarketing` mounts it twice with no override; `HOW_STEPS[0]` repeats the promise. `resolveWalletFromInput()` accepts `/^0x[a-fA-F0-9]{16}$/` or a username — a numeric id misses and the UI renders *"Couldn't find that username."* The hint directly under the input says *"Try a wallet address or username."*, so the page contradicts itself in adjacent elements | Blast radius is exactly the homepage; `WalletSearchBand`, `AccountValueSearch`, `InsightsWalletSearch` all override correctly | VERIFIED |
| D-B8 | 49 `after()` routes write a terminal `pipeline_runs` row with no invocation heartbeat | `__tests__/after-route-heartbeat-ratchet.test.ts` `BUDGET = 49`, asserted `.toBe()` in both directions. Genuinely open, correctly instrumented — named here as the largest open coded item, no action requested | VERIFIED |
| R14 | 2 `function_search_path_mutable` advisor WARNs | Unchanged; both `prokind='p'`, `prosecdef=false`, `has_function_privilege` false for anon **and** authenticated. Still correctly deferred to the next DDL window | VERIFIED harmless |

---

## P3 (recorded, not actioned)

- **~70 indexable page titles lost the brand suffix.** `app/insights/layout.tsx` and `collectionLayoutMetadata()` set `title` as a plain **string**, which replaces the resolved title object and stops `title.template` reaching their children. 9/9 sampled deep URLs render untemplated; the two one-level-deep controls (`/insights`, `/`) render correctly. The entity corpus is unaffected (`buildMeta()` bakes the brand in). ⚠ Fix is a `title.template` re-declaration on the two intermediate layouts, **not** a re-baked suffix — `__tests__/metadata-no-double-brand-suffix.test.ts` correctly bans that.
- **`sitemap.xml` `lastmod` is generation time**, identical on all five children (`new Date().toISOString()`). Google discounts a `lastmod` that always equals "now".
- **`/api/top-sales` fabricates `"Unknown"`, serial `#0` and circulation `0`, and returns 200-on-error for Pinnacle only** while the same file's non-Pinnacle branch returns 500. Live top-5 Pinnacle sales: 4 of 5 have NULL `edition_id`, 5 of 5 NULL `serial_number`. **P3 only because the route has zero non-test callers** — the live equivalents (`/api/market-analytics`, `/api/overview-stats`) are both honest.
- **Golazos `badge_editions` carry `circulation_count = 0` on 218 of 218**; `CollectionMomentTable` guards the "N minted" line but the tooltip branch renders `Circ: {…}` on a `!= null` test, so a 0 renders as "Circ: 0". **INFERRED** — refuted if `badgeInfo` is never populated for Golazos. One DOM read settles it.
- **Duplicate Top Shot player slugs grew 5 → 14.** Impact re-tested rather than inherited and is **unchanged**: all 14 pairs have exactly 1 distinct `name`, and `get_player_detail` counts editions by `(player_id = p.id OR player_name = p.name)`, so the tie-break winner claims both halves (verified on `steph-curry`: 16/82 by id, **144 by name**). Producer is still minting twins via three competing `external_id` conventions. **Do not "fix" the data.**
- **Broken image** on `/nba-top-shot/edition/262:8746::20` PARALLEL PRINTINGS (alt text "Jukebox" rendering).
- **Mobile bottom nav's PROFILE tab sends an anon first-run visitor to the login wall.** Downgraded to P3 — the login page carries two working escapes. Recorded because `WalletSearch`'s own header warns *"bouncing the #1 CTA to /login is what killed this funnel before"*, and the same shape survives one component over.
- **`check-brand-tokens.mjs`'s LITERAL check iterates a curated 54-file list while its own second half walks the tree and says why.** Population outside the list is **2, both benign** (a sanctioned chart stroke, a `console.log` CSS string). Not a live defect; filed because the derivation is the documented anti-pattern and the fix is a one-line swap to the walk already in the file. ⚠ `ConsoleGreeting.tsx` claims it is *"the only sanctioned hardcode"* — stale, there are 3 strokes plus the email red.
- **Two workflows carry the `bash -e` fallible-assignment shape**; `offer-fill-backfill.yml` is **scheduled** and has four unguarded `jq` assignments inside its drain loop that fire on 200-with-non-JSON — the documented streaming-shell case — killing the step before the branch that names the failure. `ops-monitor.yml` / `migration-parity.yml` are the correct reference impls.
- **3 production-dead components** (D30) still present. ⚠ **Register correction:** the note "deleting any requires removing its `check-brand-tokens.mjs` PROTECTED entry" is true for **only 1 of 3** — `PortfolioSparkline.tsx` is listed; the line-174 `InsiderSignals` entry is the **LIVE** `components/analytics/` file; `components/InsiderSignals.tsx` and `TierBreakdownCard.tsx` are not listed at all.
- Anon holds INSERT/UPDATE/DELETE grants on the matview `topshot_special_serial_owners_mv` — **not exploitable** (Postgres rejects DML on a matview regardless of grant); residue of a blanket `GRANT ALL`.
- `support_conversations.session_id` has no **minimum-length** `WITH CHECK` (bounded 1–128). Measured 5,155 rows / 5,103 distinct ids, modal length 31, exactly 1 id shorter than 16 chars (fixture-shaped). Adequate entropy in practice; the gap is the absent constraint.
- Two routes log the service-role key's **length** (`length: ${…?.length ?? 0}`). No value emitted; the register's "0 leaking hits" stands. Only near-miss in the class.
- Cosmetic: `/insights/cross-collection` renders "179wallets"; `/share/<wallet>` renders "25035 moments" unformatted beside a formatted "20,298"; `/insights/panini-squeeze` shows 4,676 vs 4,670 in adjacent boxes (**may be different populations — needs one adjudication, do not treat as confirmed**).

---

## Overturned, corrected, or closed this pass

**Eleven register OPEN items were already fixed inside the 134 commits.** Each verified at `origin/main`, not assumed:

| id | now | proof |
|---|---|---|
| R1 | ✅ RESOLVED | Zero `?? 0` in the overview page; **verified under a REAL `get_collection_stats` outage** (the strong form) — both named panels render "Couldn't load this right now" |
| R2 | ✅ RESOLVED | `persistAuthorized(req)` gates both handlers on `CRON_SECRET`/`INGEST_SECRET_TOKEN`, fails closed when unset; the false `proxy.ts` comment corrected in place. ⚠ **The CLASS is not closed — see D-B1** |
| R3 | ✅ RESOLVED | `lookupEditions` reads `fmv_current` chunked; residual `fmv_snapshots` read is a single-edition `.limit(21)` sparkline |
| R4 | ✅ RESOLVED, **and the pipeline half was a MEASUREMENT ARTIFACT** | The render half now carries the full three-state treatment incl. *"N more sales in this window not yet matched to a moment."* ⚠ The "escalating to 86.4% NULL" was the trailing edge of a **daily** bridge job (`bridge_pinnacle_sales_editions`, pg_cron jobid 184, `41 5 * * *`) read at one instant. Settle curve by age: 0–6h **87.31%** null → 6–24h 30.49% → 24–48h **3.61%** → >7d **0.98%**. All-time 546/194,027 = 0.28%. **Refutation condition for this overturn: if the >7d bucket exceeds ~2%, it IS a break.** |
| R5 | ✅ RESOLVED | Confirmed with **R5's own prescribed positive control**: newest `extra` contains `dist_dupe_count: 2` ⇒ the fix IS deployed. 12/12 ok in 72h; Pinnacle `pack_ev_history` 4.2h fresh, not 98h frozen |
| R7 | ✅ ceiling class GONE | Newest tick `ok: true`, `rows_written: 1005`, knots_resolved 92. **`split` ran 17,725 ms, not 125,250** — the register's "split/realign are chronic 120 s rollbacks costing 42% of budget" is **refuted for the current window**. `seed_recent` still hits 120 s but is now non-fatal (`truncated_steps: ["seed_recent"]`) |
| R10 | ✅ RESOLVED, verified in production | `lib/seo.ts` exports `OG_INHERITED`/`TWITTER_INHERITED`; **30 of 30** insights layouts reference it; live probes return `og:site_name`, `og:locale`, `og:type`, `twitter:site=@RipPacksCity` on all three sampled URLs. The "boards unfurl with no X byline" symptom is gone |
| R12 | ✅ RESOLVED both halves | `fetchSnapshot` returns `{data, ok}` and renders a distinct `ShareUnavailable`; `alternates.canonical` emitted lowercased. ⚠ Sweep D could not force the failure path live and correctly declined to call it fixed from the success path alone — the code read settles it |
| R13 | ✅ RESOLVED | `requireOwnedKey(ownerKey)` precedes the edge-fn call, fails closed |
| R15 | ✅ RESOLVED | Heading retitled `## Queued — ARCHIVE (frozen 2026-07-01; do NOT read this as the live queue)` with a pointer to the dated entries |
| R16 | ✅ RESOLVED | `process.env.DAPPER_COOKIE` / `DAPPER_X_ID_TOKEN` replace the paste placeholders |
| D31 | ✅ RESOLVED | `227c94a2` recovered 5 from prod; `migration-parity.yml` now exits on RC |

**Other corrections:**

- **The accuracy-gate "instrument disagreement" is resolved and it is not a disagreement.** The two instruments agree on 4 of 5 collections (All Day 22.8/22.7 · Golazos 0.0/0.0 · UFC 0.0/0.0 · Pinnacle 43.2/42.4). **100% of the gap is Top Shot: 49.7% vs 34.2%**, and it is one deliberate predicate — `rpc_thp_leg_fmv_coverage` filters Top Shot to canonical `setID:playID` keys, dated in its own comment **2026-08-04, "the TopShot leg is CANONICAL-ONLY"**. Arithmetic closes exactly: 13,241 canonical × 0.497 + 163 = 6,744 / 19,667 = **34.3%** vs the filing's 34.2%. ⚠ **Both numbers are honest and neither is fabricated — the problem is that two figures for "the roadmap headline metric" are in circulation with no stated denominator.** Publish it as `49.7% (canonical Top Shot) / 34.3% (all rows)` or fix the producer. ⚠ Non-canonical rows are **still being minted** (newest `created_at` 2026-08-20), so the excluded set is live, not legacy.
- **D37 SHRANK and its growth STOPPED** — was "GREW +1,376/day". Now 105,172 (from 106,069) with only **9 rows added in 24h**. Control run confirms it is not an ingest outage: AllDay `sales` took 247 rows in 24h / 10,476 in 30d.
- **D21 improved 2.25×** — AllDay `edition_offers` median staleness 11.5d → **5.11d**. P1 escalation condition still NOT met (0 of 2,294 carry a `low_ask`, so the lane cannot contaminate an ask).
- **D18 should be CLOSED as UNVERIFIABLE.** The "10 inert schedules" list was never enumerated anywhere in the repo — `docs/handoff-2026-08-09d-deep-audit.md` names exactly one member. That member (`pinnacle-sales-history-backfill`) is refuted a **third** time today (14 runs / 315 rows in 48h — the only member of the 9-pipeline family still writing anything). There is nothing left to re-verify.
- **Register "Scheduler inventory" row is stale**: Vercel crons are **36**, not 38. GHA 20 files / 17 scheduled / 19 `- cron:` lines — matches.
- **pg_cron 85 → 93 is +10 added, −2 removed**, not +8. Added: jobids 324–331 (the eight `rpc_thp_leg_*` trust-health legs), 332 (`refresh_topshot_special_serial_owners_mv`), 333 (`refresh_topshot_buyback_daily`). Removed: jobids 109 and 287 (last ticks 2026-08-16) — **unnameable from here without an 08-15 snapshot.** Six further ephemeral jobids are the documented one-off `CREATE INDEX CONCURRENTLY`/`VACUUM` pattern. **Diff the SET, not the count.**
- **`check_secdef_anon_exec_drift` set SHRANK** 4 grants / 3 fns → **3 grants / 2 fns**. Strictly better.
- **CI drifted upward on every axis**: 8 → **10** jobs (`tree-corruption`, `edge-deno` added), 0 `continue-on-error`; primary gate 91.2/78.3/93.0/93.35 → **91.8/79.4/93.6/93.85**; component 88.5/79.4/88.2/91.6 → **90.85/81.95/89.3/93.75**; workers gate now seated at 88.15/76.15/89.6/91.1.
- **UFC FMV coverage 89.77% → 100.00%.** A real gain.
- **`fmv-recalc`'s "72.7% wall-kills" is stale in both directions.** Per-day: 08-19 1/29 · 08-20 63.9% · 08-21 44.6%; `v_pipeline_failure_rates` currently 58.2%. Throughput **improved**: 14,640 / 15,106 / 16,230 editions/day. "Wasteful, not broken" holds. ⚠ Sharper restatement: all work lands in 5–6 productive hours of 24 — today 01:00–15:00Z was **21 runs, 0 ok, 0 rows**.
- **`sets_summary` at 8.6 h is correct-by-cadence, not stale** — pg_cron jobid 37 is `50 7 * * *`, 3/3 succeeded. The register's 0.5h reading was a sample-time artifact.
- **CLAUDE.md's "TopShot 1,929 low_ask of 6,930 ≈ 28%" is stale in a second direction** — now **12,259 of 12,464 = 98.4%**.
- **R11's pipeline half is healthy; the detector residual STANDS.** 72h: 7 terminal rows / 7 ok vs **21 heartbeat rows** — still ~1 terminal per 3 ticks, so `detect_stalled_pipelines()` will keep oscillating on a demonstrably alive pipeline. No fix has landed.
- **Two trust-board arms are inconclusive right now**, not clean: `public_board_empty_count` and `public_board_slow_count` both read **999**, the failure sentinel, age 1.8 h. **999 is not a count.**

**A candidate finding raised and then refuted — recorded because the refutation is the lesson.** A `mean_gap_min` sweep showed the entire `wallet-backfill*` family (7 pipelines, ~4,700 runs/24h) silent for 81 minutes and `panini-ingest` silent for 155 minutes, reading exactly like a live coordinated stall. It is not: both are **burst-scheduled**, and hourly bucketing across two 24h windows shows `panini-ingest` firing in dense bursts at hours 1, 5, 9, 13, 17, 21 with identical shape in the prior window. **A mean gap is not a cadence, and on a bursty pipeline it manufactures a stall that is not there.**

---

## Measurement limits — stated rather than papered over

- **`get_advisors` could not be read this pass.** Both `security` (132,475 chars) and the register exceeded the tool output cap, and the tool-results file is written outside every mounted path. Every ERROR- and WARN-class Supabase lint was replicated as catalogue SQL instead. **Not replicated: the 7 known-benign `*_security_definer_function_executable` WARNs** — that is not a stock lint name and its predicate could not be reconstructed. **Refuted if** a re-read of `get_advisors(security)` in a context that can hold it shows any WARN outside the 7 + the R14 pair.
- **D25's fixable-vs-`upstream_wrong` split could not be obtained** — the `wallet_moments_cache ⋈ editions` join over 2.29M rows hit `57014` twice and was not retried further. The wmc-grain count (**67**: TS 63 · Pinnacle 4 · **AllDay 0**) is reported instead, and it is **not interchangeable** with the register's 62, which was `editions.circulation_count` grain.
- **A single-query Top Shot confidence split by key shape timed out at 60 s.** Worked around by measuring the non-canonical leg alone (n=6,597) and deriving the canonical leg from the precompute's own denominator — the arithmetic is shown above so it is auditable rather than asserted.
- **Live CI run status is not readable from this sandbox** (no `gh` auth). The in-repo watcher `ops-monitor.yml`'s `ci-status` job is correctly hardened (`set -euo pipefail`, empty `RUN` treated as inconclusive rather than green).
- **51 of 233 `.in(col, ident)` sites have no chunk/slice/limit within 25 lines.** Three were spot-checked and all three refuted (upstream caps, idempotent upsert, loop bound). **48 remain unexamined — this is a spot-check, not an exhaustion.**
- The wallet-search box was **not** submitted live; that would write a `wallet_paste` row to production. D-B7 rests on the code path, which is unambiguous.
