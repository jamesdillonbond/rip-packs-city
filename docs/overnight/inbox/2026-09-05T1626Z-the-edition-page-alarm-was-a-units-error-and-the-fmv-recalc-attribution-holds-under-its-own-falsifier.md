# The edition-page alarm I nearly raised was a UNITS ERROR, the `query_sql` attribution HOLDS under its own falsifier, and the #1 physical reader has changed hands

**Filed 2026-09-05 09:26 PT (16:26Z), Claude Code (Trevor's box, interactive). MEASUREMENT ONLY — nothing shipped, nothing changed.**

Started from three `[edition]` statement-timeout groups in the Vercel error surface and ended up correcting myself twice. All figures are `ops_pgss_delta('24 hours')` with `counter_reset = false` on every row — **not** a hand-rolled difference, which invented a runaway earlier today.

---

## 1. 🚨 The edition page is NOT an IO problem, and my first reading said it was

`pg_stat_statements` cumulative totals made the edition page's three RPCs look enormous — `get_edition_recent_sales` at 218,206 calls and 102,128 s, `get_edition_market_bundle` at 107,980 calls and 52,327 s. **Both numbers are real and both are misleading**, for two independent reasons:

- ⚠ **They are CUMULATIVE since `stats_since = 2026-08-12`** — ~24.6 days, not a day. Read as a rate they overstate by ~25×.
- 🚨 **The "blocks" figure I first computed was `read + hit`, i.e. LOGICAL accesses, while the metric that binds this instance is PHYSICAL reads.** `market_bundle` shows **34,458,417 logical** — which would have made it ~3× the platform's recorded #1 reader — but **1,926,304 physical against 32,532,113 cache hits**. It is **94.4% served from cache**.

**Ranked properly by `d_shared_blks_read` over 24 h, `market_bundle` is 11th**, not first.

| | pooled mean (24.6 d) | recent (24 h) |
|---|---:|---:|
| `market_bundle` ms/call | 485 | **213** |
| `recent_sales` ms/call | 468 | **81** |

⭐ **So the 7 `market_bundle` timeouts in 24 h are CONTENTION, not cost.** The function is not heavy; it is a well-cached read that occasionally loses a race against the `authenticator` 8 s cap — note all three groups top out at **7,940–8,000 ms**, which is that cap, not a coincidence. This is the same shape as tonight's trust-board finding, where `topshot_2025_rookie_cohort_stats` returns the same 1 row in 830 ms or 5,133 ms depending on instance load.

⛔ **Do not "optimise" these three RPCs on the strength of the cumulative table.** The lever is whatever is causing the saturation spells, and it is not here.

ⓘ **Their honesty handling was checked and is CORRECT — no action.** Both fetchers return `{data: EMPTY, ok: false}`, `active_listings` is gated on `typeof === "number"` so a dead feed cannot publish `0.0% listed`, and `page.tsx` documents deliberately why it consumes `.data` and not `.ok`: every render site gates on `!= null`, so a failed read degrades to an em-dash or a hidden section rather than a fabricated zero.

---

## 2. ✅ The `2026-09-04T0500Z` filing's attribution HOLDS — its falsifier was RUN, not re-read

That filing named `query_sql` the database's #1 reader at **12,125,016** blocks/24 h and stated its own falsifier: *"If `query_sql` is not in the top 3 by `d_shared_blks_read`, the attribution is stale. If it is, count `pipeline_runs` rows for `fmv-recalc` in the same window and multiply by 7 — the product should be within ~30% of `d_calls`."*

⭐ **That sentence also settles the units**: the filing measured `d_shared_blks_read`, i.e. **physical reads** — directly comparable to the numbers above, which is exactly why §1's mistake was worth catching.

| test | result |
|---|---|
| still top-3 by physical reads? | ✅ **yes — #2** (6,798,496) |
| 152 `fmv-recalc` runs × 7 | 1,064 predicted vs **1,302** actual `d_calls` |
| deviation | **18.3%** — inside the stated ~30% |

**Both clauses pass. `fmv-recalc` still owns `query_sql`, and the "seven ad-hoc scans per run" model still describes it.**

⚠ **Its magnitude fell sharply though: 12,125,016 → 6,798,496 physical reads/24 h, a 44% drop, and it moved from #1 to #2.** ⛔ **I am NOT attributing that to the Step 6 rewrite.** Step 6 is one of the seven scans, several other changes landed in the same window (the `pack_ev_latest` rewrite, the Step 5b work), and a 24 h delta spans them all. **A drop consistent with a fix is not evidence for that fix when three fixes share the window** — this is the pooled-across-a-change trap in a new costume. What can be said is narrower and still useful: *the platform's biggest reader got materially cheaper and its attribution did not change.*

---

## 3. ⭐ The #1 physical reader has changed hands — and the new one is deliberate

| rank | statement | physical reads / 24 h | calls | DB-s |
|---:|---|---:|---:|---:|
| 1 | `reconcile_wmc_metadata_from_editions($1,$2)` | **9,058,903** | 146 | 4,428 |
| 2 | `query_sql` (fmv-recalc) | 6,798,496 | 1,302 | 2,989 |
| 3 | a PostgREST RPC | 4,495,963 | 291 | 2,851 |
| 4 | `atlas_editions_drain()` | 4,175,868 | 731 | 746 |
| 5 | `refresh_wmc_fmv_changed($1,$2)` | 4,096,160 | 146 | 3,191 |

The new leader costs **~62,000 physical reads and ~30 s per call** across only 146 calls. ⓘ **It is one of the 09-04 audit migrations** (`…wmc_metadata_reconcile_corrects_truncated_and_placeholder_set_names…`), a deliberately chunked reconciler whose own header records that its cost scales with *holder rows, not editions*. **So this is expected spend on a draining job, not a defect** — but it is worth knowing that the platform's top reader is now a backfill that should eventually finish, and **worth re-checking that it does**. If it is still #1 in a week having drained nothing, that is a finding.

---

## 4. ⚠ Checking health is not free: `rpc_ops_snapshot()` costs ~295k physical reads a call

**2,067,514 physical reads across 7 calls in 24 h** — ~**295,000 reads and ~28 s per invocation**. It has **no repo caller**; it is a hand-query run by operators and agents to answer *"is the platform healthy"*.

👉 **Consequence worth internalising: an agent that opens a session by running the ops snapshot has already spent more physical IO than 150 edition page loads.** On a SMALL, IO-bound instance during Trevor's waking hours that is not free. Prefer the targeted arm you actually need (`v_rpc_trust_health`, a single `pipeline_runs` query) over the whole snapshot, and take the snapshot deliberately rather than reflexively.

---

## 5. Falsifiers for this filing

1. **§1** — re-run `ops_pgss_delta('24 hours')` and rank by `d_shared_blks_read`. If `market_bundle` appears in the top 5 *by physical reads*, §1 is wrong and the edition page really is heavy.
2. **§2** — repeat the two clauses above. Attribution goes stale if `query_sql` leaves the top 3 or the ×7 model deviates beyond ~30%.
3. **§3** — if `reconcile_wmc_metadata_from_editions` is still #1 a week from now, check whether its target set is actually shrinking; a chunked reconciler that never finishes is the treadmill shape this repo has recorded before.
4. **§4** — `SELECT d_shared_blks_read / d_calls FROM ops_pgss_delta(...) WHERE q LIKE '%rpc_ops_snapshot%'`.

⚠ **Every number here is a dated sample on a shared, load-varying instance. Re-derive before quoting.**
