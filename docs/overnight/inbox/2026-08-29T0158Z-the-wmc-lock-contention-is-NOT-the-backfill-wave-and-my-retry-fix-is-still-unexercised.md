# The `wallet_moments_cache` lock contention is NOT the backfill wave — and my own retry fix is still unexercised

**Filed 2026-08-28 (PT) by Claude Code, autonomous pass.** Two claims here, one a refutation of my own hypothesis and one a refusal to credit my own fix.

---

## 1. My retry-slice fix (`f20e79602`) is STILL UNEXERCISED, and the improvement is not evidence for it

Shipped earlier tonight: `minAttemptSliceMs` on `lib/analytics/rpc-with-retry.ts`, wired only into `lib/chains/flow/wmc-chunk-upsert.ts`, to stop the third retry attempt being handed a budget crumb too small to be a real attempt — which both fails and **overwrites the true cause with our own bound**.

Split on the deploy (2026-08-28 22:57Z push, allow ~8 min to deploy), wave-vs-wave:

| era | window (UTC) | `wallet-backfill*` runs | runs with `wmc_upsert_chunk_failures` | rate | `rows_lost` |
|---|---|---|---|---|---|
| pre-fix | 12:45 – 14:59 | 1,421 | 50 | **3.52%** | 12,611 |
| post-fix | 23:40 – 01:33 | 1,746 | 5 | **0.29%** | 3,856 |

⛔ **That 12× is NOT attributable to the fix, and I am not claiming it.** Three reasons, each sufficient on its own:

1. **n = 1 wave on each side.** The gate (`utcHour % 12 >= 2`) means these are two single waves nine hours apart, not two samples of a distribution.
2. ⭐ **None of the 5 residual failures has the shape the fix targets.** The fix only fires when a retry loop has less than 30 s of budget left after a slow failure — the ~68 s cluster. The five post-fix causes are **3 × `canceling statement due to lock timeout`** and **2 × `Could not query the database for the schema cache. Retrying.`** Neither reaches the floor. **The floor has still never fired in production.**
3. **A zero is not a measurement of a guard that never ran.** This restates the 17:11 PT ledger note ("803 clean runs, and that zero is not evidence for it") with a larger population and the same conclusion.

⚠ **The right exit condition remains: a `rows_lost` failure whose `first=` names a REAL upstream cause rather than our own 45 s bound.** Until one appears, the fix is inert-and-unproven, which is the honest state.

⭐ **One of the two schema-cache failures is SELF-INFLICTED and I can name the cause.** `Could not query the database for the schema cache` is PGRST002, the ~10–20 s re-introspection burst every `apply_migration` causes (CLAUDE.md, DB section). The two hits are at **01:29:03.974Z and 01:29:04Z**; migration `20260829012854_audit_20260828_wallet_backfill_cadence_arms_cannot_be_green` was applied at **01:28:54Z**. Nine seconds. **This is the documented cost of applying a migration during a backfill wave, observed rather than predicted** — worth knowing that it lands as `rows_lost`, not as a 500 someone sees.

---

## 2. REFUTED: the lock timeouts are not caused by the wallet-backfill waves

**Hypothesis** (mine, and it was tidy): `refresh_wmc_fmv_changed`'s **51 `canceling statement due to lock timeout`** failures in 24 h and `wallet-backfill*`'s `rows_lost` are two sides of one fight over `wallet_moments_cache` rows — the backfill's `upsert_wmc_batch` against the refresher's `UPDATE wmc SET fmv_usd`.

**Test:** the backfill waves run ONLY in UTC hours 0, 1, 12, 13 (plus the GHA backstop). If the hypothesis holds, the lock timeouts concentrate there.

**Result — they do not. They are close to uniform across all 24 hours:**

```
hour   00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23
locks   4  4  3  1  3  3  2  0  3  0  2  2  2  1  1  4  3  1  3  2  3  1  2  1
wallet 306 645  0  0  0  0  0  0  0  0  0  0 191 614 616  0  0  0  0  0  0  0  0 795
```

**Wave hours (0, 1, 12, 13) hold 11 of 51 lock timeouts. The 20 hours with ZERO wallet-backfill runs hold 40 of 51.** The refresher's runs are near-uniform (11–14/hour), so this is a rate comparison, not a volume artifact. ⛔ **Hypothesis refuted.**

⚠ **A second control falls out of the same table and points the other way too:** UTC hour 23 had **795 wallet-backfill runs and ZERO `rows_lost`**, while hour 13 had 614 runs and 9,153 rows lost. **Wave volume does not predict loss.** Whatever drives the loss is episodic, not load-proportional.

**Next suspect, stated as a suspect and not a finding:** `rpc-backfill-wmc-fmv-confidence` (pg_cron jobid 302, schedule `2-59/5`) also writes `wallet_moments_cache` and runs every five minutes around the clock — which matches the uniform shape the waves do not. ⛔ **Not investigated. Do not act on this line without reading `cron.job.command` for jobid 302 and confirming what it actually writes** — the name is not the callee.

---

## Not established

- ⛔ **Why hour 13 lost 9,153 rows and hour 23 lost none.** Not investigated.
- ⛔ **Whether `rows_lost` is permanent.** `wallet-backfill` re-sweeps wallets periodically, so a lost chunk may simply be re-upserted on the next pass — in which case the number overstates the harm. **Nobody has checked, and the metric is quoted as loss in several places.** This is the question that decides whether any of this is worth fixing.
- ⛔ **Whether the 51 lock timeouts cost anything.** `refresh_wmc_fmv_changed` is resumable and its cutoff advances only over what it drained, so a lock timeout may be a clean no-op rather than a loss.

---

## UPDATE 2026-08-29 ~15:50Z — both open questions answered

**1. ✅ The retry-slice floor's exit condition is MET.** Re-measured across the whole
`wallet-backfill` family (not one wave), 24 h either side of the 23:10Z deploy: runs whose
`first_chunk_error` names our own bound below 30,000 ms went **15 → 0**
(P(0 | Poisson 12.1) ≈ 5.5e-6), while the ~68 s cluster (31 → 10) and the pool/lock messages
the retry exists for (76 → 69 pool) both persisted. The stated falsifier — crumbs in the
3–6 s range persisting — did **not** fire. As predicted, **no rows were recovered**; the
losses simply keep their real error text now.

**2. ⛔ `rows_lost` is NOT permanent — this filing's own "NOT established" is now settled,
and it settles against the loss reading.** Direct check, 131 AllDay wallets scanned in the
last 72 h with `last_found_count > 50`: **zero** hold fewer `wallet_moments_cache` rows than
their recorded found-count (0 missing of 234,235 claimed). Positive control: six wallets
chosen for having lost >200 rows in one run were each re-scanned **2–7 times** since, and all
six are whole or over-complete. Per-wallet `scan_count` runs 234–654, i.e. every seeded wallet
is re-enumerated several times a day, so a lost chunk is re-upserted within hours.

⚠ **This does not make the number harmless, it re-files it.** ~93,000 rows / 72 h are still
re-done on AllDay alone (33.7% of what that pipeline writes), and only 5.7% of that is credited
to the retry — on an instance whose binding constraint is disk IO. **It is an IO-waste story,
not a data-integrity one, and the two need opposite responses.** `chunk_rows_lost` has been
quoted as data loss in several places including CLAUDE.md-adjacent notes; the module's own
docstring calls it "an upper bound on rows lost this run", which is the accurate wording.

⚠ One residual is now named rather than guessed: the two PGRST002 losses ARE retried
(`isTransient` classifies PGRST002 correctly, deliberately, since 08-13) — they fail because
the retry spread is ~2 s of backoff against a schema-cache re-introspection window an order of
magnitude longer. 511 rows, 0.5% of the 72 h loss. **Not worth a change**, recorded so the
next reader does not re-derive it as a missing classification.
