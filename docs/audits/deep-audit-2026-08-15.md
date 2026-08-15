# RPC monthly deep audit — run 2 (2026-08-15)

Ran ~01:00–02:30 PT. Six parallel sweeps (security · pipelines · data integrity · rendered-DOM · codebase/backlog · growth) on top of a cheap re-verification of the run-1 register.

**Constraint that shaped the whole pass:** the Cowork shell sandbox was down (`useradd` / `/sessions` disk-full class, ~8th occurrence), so there was **no git and no push**. DB-side work shipped; every code-side fix became a handoff. Separately, the instance was **in an active disk-IO saturation episode throughout** (7 long-running queries, 8 `DataFileRead` waiters; three of Sweep C's probes died at 60 s). That is load-bearing context — it *exposed* several code defects and it also produced failures that are honest and correct. They are separated below.

---

## Shipped

| # | change | verification |
|---|---|---|
| 1 | **`audit_20260815_collection_stats_prune_future_fmv_partitions`** — `AND computed_at <= now()` on both `fmv_snapshots` LATERALs in `get_collection_stats` (TopShot + All Day branches) | `Subplans Removed: 1`; that leg **7,763 → 6,220 buffers (−20%)**. Equivalence **proven, not sampled**: 0 future-dated rows table-wide. Guarded migration (refuses unless the pattern appears exactly twice; refuses if already patched); nothing hand-transcribed. ACL / SECDEF / `search_path` verified unchanged; anon+authenticated EXECUTE `false`, service_role `true` |
| 2 | **`candy-listings-indexer` severity `info` → `medium`** + both stale claims in its note corrected | Applied and read back. Class swept (every watchlist/suppression note justified by "unpublished / not user-facing / no-op") — exactly one live instance |

Post-ship: `check_public_security_invariants()` **0** · `check_anon_write_surface()` **0** · `jsonb_array_length(check_secdef_anon_exec_drift())` **0** · RLS-off **0**.

**Original `candy-listings-indexer` note text, preserved for the revert:**

> Magic Eden secondary LISTINGS (asks) sweep for candy_mlb (Vercel cron 35 */3). Ask/floor signal — never FMV, never writes fmv_snapshots. Unlocks the deals/offer-spread/floor family (Candy had no ask feed before). Currently a clean no-op (ME listedCount 0 under the quest-hold rule); captures the first real ask automatically. 400m ~= 2.2 missed ticks. info severity: candy_mlb is unpublished (gated /insights/candy-mlb) so a stall is not user-facing. Added 2026-07-24 with the pipeline. Revert: DELETE FROM pipeline_cadence_watchlist WHERE pipeline='candy-listings-indexer'.

---

## The headline

**`/nba-top-shot/overview` and `/nfl-all-day/overview` state "No sales in the last 24h" while Top Shot did 8,332 sales and All Day 240 in that window.**

The honest layers all work: `/api/collection-stats` returns a proper 503, the KPI band shows em-dashes, and the page renders *"Couldn't load collection stats right now."* Then `overview/page.tsx:331` and `:444` apply `?? 0` to the same NULL `stats` and turn it into a market assertion. The page contradicts itself on screen — its own Insider Signals panel simultaneously lists floor sweeps of 269 and 171 moments from 1–2 h earlier.

This is the **sixth** instance of the failure-renders-as-data class, and it is on the very page D11 was fixed on: D11 hardened the KPI band directly above these two panels and did not reach them.

**And the timeout underneath it is ours.** `get_collection_stats` throws `57014` inside the sniper-deals LATERAL added by `audit_20260810164226` — the D4b/D13b confidence gate **this audit shipped in run 1**. A fix that improved honesty bought a cost that now defeats the same page a different way. The mitigation shipped above cuts that leg by 20% and **is not a rescue**: post-patch the function returned correct data in **84 seconds**, and All Day still threw, the trace naming `line 214` with the new predicate visible in the running code. All Day drives **2,230 LATERAL loops vs Top Shot's 769** — which is why it fails first.

---

## New this pass, not previously known

- **P0 (latent).** `/api/edition-floor` lets an **unauthenticated** caller trigger a service-role `DELETE` on `fmv_snapshots` for ≤50 editions via a caller-controlled `?persist=1`, under a `proxy.ts` comment asserting "No writes, no user data". Not firing today (no production caller passes `persist`). ⚠ `check_anon_write_surface()` is blind to it by construction — it tests the anon **DB role**, not a route holding the service-role key.
- **P1.** `/api/fmv`, the documented product API, reports **"No FMV data yet" for editions we have priced** — the D27 anti-pattern, unfixed here while two sibling routes fixed it and left comments citing D27. At 40.7 snapshots/edition the 1000-row cap covers **50 of a 100-edition batch**.
- **P1.** **Pinnacle sales stopped resolving `edition_id` at ~2026-08-14 16:00Z and it is escalating** — 0% → 9.3% → **86.4%** hourly, all 193 of the 30-day nulls inside that window. It is why `/disney-pinnacle/overview` renders RECENT TOP SALES as a blank box with no copy at all.
- **P1.** `drain-conflated-subeditions` is **100% dark-killed** — 5/5 runs write only the start marker (`duration_ms` 147–176 ms), last success 2026-07-31, on no watchlist. Its step 5 refreshes the conflation detector, so **that guard has been stale by construction for ~15 days**. The D6 fix made it visible, not working, and the 300→600 ceiling raise did not help.
- **P2.** The homepage publishes three serial-premium multipliers the live model does not produce — claims 12× / 4.5× / 3×, live values **9.89× / 1.50× / 5.00×**, two wrong in *opposite* directions.

---

## Corrections to prior findings (inherited severities that were wrong)

| item | run-1 record | run-2 measurement |
|---|---|---|
| **D2b** | `backfill-topshot-pack-supply` ✅ "rotated + verified"; 7 others ❌ failing | ⚠ **INVERTED.** 71 of 71 `pg_net` 403s land on jobid 16's minutes, 0 off them; every other gate-keyed job is healthy. Blast radius smaller than P0 implies (only the frozen `gql_historical` lane), but the **secret-exposure** half is untouched and remains the real P0 |
| **D32** headline | `topshot-onchain-art-backfill` — a green pipeline accomplishing nothing, 100% resolver-miss | ✅ **RESOLVED** — now `thumbs_filled 66 / videos_filled 65 / rows_written 131` |
| **D8** | 197 after repair; predicted to regenerate in **All Day** | **7,369 (37×)**, and in **Top Shot** (7,087); All Day held at 208. Only **1,725 (23.4%)** are healable defects — the rest have no `edition_key` at all |
| **D25** | AllDay 25 stale-denorm / 32 upstream-wrong | AllDay now **57 / 0** — the whole AllDay half is correctable |
| **D26** | 4 duplicate player slugs | 5, and the **set churned** (2 healed, 3 new) — so the finding is the *producer*, a third `external_id` convention |
| **D37** | 97,812 unresolved | **106,069** (+1,376/day) |

---

## Traction (Sweep F, like-for-like 30d vs prior 30d)

| metric | 30d | prior 30d | direction |
|---|---|---|---|
| **`wallet_paste`** | **9 events / 7 sessions** | 3 / 2 | up (31 all-time; ≈0.3/day) |
| anon sessions (excl. new `collection_view` instrumentation) | **124** | 240 | **▼ 48%** |
| `auth.users` new | 1 | 0 | +1 (21 total) |
| WAU | **2** — of which **1 is Trevor** | 0 | 1 non-owner |
| `support_conversations` (`WHERE NOT is_smoke_test`) | 8 | 38 | ▼ 79%; **newest real conversation 2026-07-21** |
| `email_subscribers` | 0 | 0 | table has never held a row |
| `profile_bio` with a username | **20 / 20** | 4 / 20 | ✅ the 08-14 backfill claim verified |

Flat-to-declining on every comparable basis. Per the roadmap's own framing that is the **expected output of the current input** — four of six collections sit below one-third HIGH/MED confidence (TS 54.9 · Candy 60.0 · Pinnacle 30.8 · AllDay 27.8 · Golazos 0.7 · UFC 0.0). No growth work is indicated and none is proposed.

One genuine defect on the growth side rather than a strategy choice: **the funnel cannot measure its own conversion.** `session_id` lives in `sessionStorage`, which is per-tab, so the magic-link hop resets it — `home_view → signin_click → account_created` can never be joined. `signin_click` has **zero rows all-time** despite being wired at two homepage sites; a single manual click settles whether that is genuinely zero or a lost write, and is worth running before any other funnel work.

---

## Method notes

- **The `pipeline_runs.extra` payload settled almost every pipeline question again.** It split four pipelines that look identical in `rows_written`: `topshot-sales-history-backfill` returns `{"note":"queue_empty"}` in 0.7 s (a correct, cheap no-op) while `golazos-`/`ufc-sales-history-backfill` scan 40,000 blocks and decode zero. And `compute-laliga-pack-ev` logs `{"phase":"invoked"}` with 0 rows — which the rollup alone would have condemned as inert, when `pack_ev_history` for Golazos is 1.5 h fresh and it is simply the fire-and-forget invoker.
- **A watchlist/suppression justification is a claim with an expiry date.** Added to the register's cheap checks.
- **Grep before you measure paid for itself again.** `check-migration-parity.mjs` keys on migration NAME; a version-keyed comparison overstates the 3-day gap by a third (9 → 1 real + 5 self-cancelling prototypes).
- **Reading all 101 root handoffs (not just ledger-referenced ones) closed a second instance of the D28 trap** — Phase F's handoff still carries an unticked "do NOT do" checkbox for work that shipped 2026-06-01. Handoffs are never updated on completion; that is the mechanism.
- **A cost estimate is not a measurement and one warm timing is not a cost.** The patched leg read 5,847 ms then 358 ms either side of the change — cache and load, not a 16× speedup. Only the buffer count is quotable.
- **Sweep D's Chrome profile was signed in**, so the anonymous home page and all gating behaviour were reported NOT-CHECKED rather than assumed.

---

## Gaps in this pass

- **No code shipped** — shell down. Everything in `docs/handoff-2026-08-15-deep-audit-run2.md`.
- **Duplicate-serial ghosts in wmc are UNMEASURED** — three `GROUP BY (edition_key, serial_number)` probes timed out at 60 s under saturation. Needs a quiet window or a per-wallet-bounded rewrite.
- **D31's 14-day fileless subset** was not computed name-keyed (Glob truncates at 100 against 284 `202608*` migrations, and no shell). Run `npm run db:migrations:check --window_days=14`.
- **The D8 wmc self-heal was deliberately not attempted** — fill-only and idempotent, but CLAUDE.md records the automated sweep being removed after 3/3 saturation failures, and the instance was saturated. Attempting a known-to-fail-under-saturation operation during a saturation episode is repetition, not judgement.
- `public_board_slow_count` is breached and **growing** (3 on 08-13 → 6 → **9**). Noted, not investigated.
