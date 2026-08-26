# Handoff — 2026-08-25 (PT) overnight Cowork cloud pass

**Session:** Cowork cloud, interactive → unattended. **Git push: NOT AVAILABLE** (diagnosed to the
layer, §6). Everything DB-side is already live in production; everything code-side is in a 4-commit
patch set that needs one `git am` + `git push` from your box.

> ⚠ **This blocker is specific to this cloud session.** Your machine and Claude Code push normally.
> **Commit and push these files as usual.**

---

## 0. One-minute version

| | |
|---|---|
| **Shipped to prod (DB), no push needed** | a 99 MB index that had been unusable for 75 days, repaired · two backfill jobs cut 5× (71.9 GB/day of disk reads) · an anon-readable table closed |
| **Diagnosed a 7-day P0** | Sentry is not broken — the **org error quota is exhausted**, and one signature burned it |
| **Waiting on you** | apply the patches; raise the Sentry quota; one decision on the biggest job on the instance |
| **Two retractions** | one of someone else's claim, one of my own — both would have caused damage |

---

## 1. Apply the patches (5 minutes)

Four commits, based on `origin/main` and **verified to `git am --3way` cleanly onto a fresh clone**
of the newest head (`639b6fa`), with the ledger, INDEX, CLAUDE.md-size and new tests all re-run
**in the applied tree**, not just in mine.

```bash
cd /c/Users/TDill/rip-packs-city   # or wherever your working clone is
git fetch origin && git checkout main && git pull --ff-only
git am --3way /path/to/patches/*.patch
npm test && npx tsc --noEmit
git push origin main
```

| # | commit | what |
|---|---|---|
| 1 | `fix(sentry): bound how much of the org error quota one signature may consume` | the durable half of the Sentry fix |
| 2 | `fix(telemetry): logRun swallowed its pipeline_runs insert error…` | + one comment that named the wrong timeout |
| 3 | `docs(migrations): record the DB changes applied from a session that could not push` | **this one un-reds `migration-parity`** |
| 4 | `docs: five filings, three ledger entries, three register items…` | ledger, inbox, known-issues 34/35/36, CLAUDE.md, database.md |

🚨 **Commit 3 is time-sensitive.** `migration-parity` is **enforcing** (its `|| true` came off
2026-08-20) and matches on migration NAME against `git ls-tree HEAD`. Five migration names are in
prod with no committed file right now, so it reds at its next scheduled run until this lands.

⚠ **CLAUDE.md will be at 3 characters of headroom** after this (39,997 / 40,000). That is the file
working as designed — it is at its size equilibrium — but the next durable rule **must** displace
text, and a concurrent edit could tip it over. I paid for both of my additions by moving text
verbatim into `routes-and-surfaces.md`.

---

## 2. Shipped to production already (DB) — with revert paths

### 2a. The `fmv-recalc` index was unusable for 75 days. Repaired.

`idx_sales_2026_fmv_recalc_window` — 99 MB, built for `fmv_recalc_edition_page`, scanned **3 times
in 75 days**. Cause: its predicate carried `edition_id IS NOT NULL`, and **PostgreSQL 17
constant-folds that qual out of the query before predicate proving** because the column is
`NOT NULL`. The index predicate then cannot be proven and the index leaves the candidate set.

Rebuilt without the redundant conjunct via the one-off pg_cron `CREATE INDEX CONCURRENTLY` recipe:
**202 s**, `indisvalid`, old index dropped concurrently, new one renamed back to the documented
name. Role budget restored, active job count back to its 99 baseline, zero invalid-index debris —
all verified, not assumed.

**On the unmodified production query:** plan node **51,040.92 → 15,264.74**;
`EXPLAIN (ANALYZE, BUFFERS)` **18,124 ms** against the **50,471 ms** on record — **~2.8×**,
reproducing the predicted 2.9×.

⚠ **The buffer half of the prediction did not reproduce**, and I would rather say so than round it
off: predicted ~48,494, measured 84,667, and `Heap Fetches: 82,082` is the entire gap. The
visibility map was at 83.2%; a `VACUUM (INDEX_CLEANUP OFF, ANALYZE)` took it to 88.6%.
ⓘ The first post-fix call read **2,874** disk blocks against a **31,564** lifetime average — but
n = 1 is not a rate, and **the honest post-ship metric is blocks-per-call over 24 h, which has not
been taken.**

**Revert:** rebuild the old predicate as a one-off pg_cron CIC (statement in the migration header).
There is no scenario where the old predicate is preferable.

### 2b. Two backfills were 71.9 GB/day of disk reads for ~165 rows/day. Cut 5×.

`topshot_pack_sales_history` reads **3,558 inserts against 14,903,768 updates**; allday **106
against 9,956,771**. PostgREST's default `ON CONFLICT DO UPDATE SET <every column>` has no
change-detection predicate, so every re-walk of immutable historical sales rewrites every row
identically. Four statements = **~9.2% of the instance's ~780 GB/day of disk reads**, 1.57M blocks
dirtied/day, 4.55 GB/day of WAL.

⭐ **The bigger half is not the upserts** — it is two `SELECT … LIMIT $1 OFFSET $2` statements at
**19,183** and **16,587** disk blocks *per call*, re-reading whole tables ~200×/day each. Same
"OFFSET does not paginate" defect as the Flowty filing.

Cut jobids 25/29 from a 3-minute to a 15-minute cadence, offset by a minute. Not a freshness
regression: the newest rows were already **3.4 h** and **15.3 h** old.

⛔ **The real fix — `suppress_redundant_updates_trigger()` — was deliberately NOT shipped.** A
suppressed row emits no `RETURNING`, PostgREST's `page_total` falls, and **both writers are edge
functions with no committed source** (deep-audit R21), so a caller asserting on that count would
break silently and invisibly for days. **Committing those two functions unblocks it.**

⚠ **Falsifier — please let it run, don't assume it.** Over 24 h, `n_tup_ins` should hold (topshot
~160/day, allday ~5/day) while `n_tup_upd` falls ~5×. **If INSERTS fall too, the walk was covering
ground and this cut is wrong.** Revert: `cron.alter_job(25, schedule := '*/3 * * * *')` and
`(29, '1-58/3 * * * *')`.

### 2c. An anon-readable scratch table — mine — closed

A measurement baseline table I created was `anon`-SELECTable with RLS off twenty minutes later
(known-issues #11's `ALTER DEFAULT PRIVILEGES`). It **reddened the smoke test**, and a concurrent
Claude Code session found and filed it before I did. Both of its reasons for filing rather than
fixing were correct, and I appended the resolution to **their** filing rather than opening a second
one. `REVOKE` + `ENABLE ROW LEVEL SECURITY` applied; `check_public_security_invariants()` now
returns zero rows — read as clean only after confirming from the return type that zero rows is this
function's clean state.

**Estate sweep:** tables anon can SELECT with RLS off → **0**; anon-readable views that are not
`security_invoker=on` → **0**. ⚠ The tables sweep **has a positive control and passed it**; the
views sweep has none, so it is "found nothing", not "proved nothing is there".

⏳ **One thing left for you or the next pass:** `public._rpc_waste_baseline_20260825` still exists
(RLS on, no grants). It holds the pre-change baseline for §2b's falsifier. **Once that reading is
recorded: `DROP TABLE public._rpc_waste_baseline_20260825;`** — every number in it is already in the
ledger and the filings.

---

## 3. 🚨 Sentry — needs you, and it is now a decision rather than an investigation

**Settled by one request.** A POST of a minimal envelope at the production DSN answers:

```
HTTP/2 429
x-sentry-rate-limits: 60:default;error;security;attachment:organization:error_usage_exceeded
```

**The org's error quota is exhausted.** Sentry is up, the DSN is valid, the key is live (an empty
body returns `400 empty request body`, which proves reachability and auth), the SDK is fine, egress
is fine. Last accepted event: **2026-08-18T13:21:59Z**.

⛔ **Three earlier filings recorded that this could not be tested from here. That premise was
false**, and it is why this sat open for seven days. The lesson is in the filings: **when an
observability pipeline goes dark, probe the collector before auditing the emitters.**

**What burned it:** ONE already-tracked signature. `edition detail unavailable: rpc
get_edition_detail timed out after 45000ms` threw **15,388 times across 2,963 distinct users in one
week**, from the edition page alone. **So raising the quota alone buys about two days.** That is why
commit 1 exists.

👉 **Your action:** Sentry → Settings → Subscription. Raise the plan or enable an on-demand budget —
**together with** commit 1, not instead of it.

⚠ **And nothing watches this.** A collector that has been dropping for a week looks exactly like a
quiet week. An arm on "Sentry accepted an event recently" is now worth building, because the quota
is a known recurring failure mode.

---

## 4. ⭐ The biggest thing I found, and it needs one decision from you

**`refresh_wmc_fmv_changed` is 40.2% of every block this database dirties** — plus 10.0% of disk
reads, 37.2% of WAL and **11.0 hours a day** of exec time across its two callers. Larger by itself
than everything in §2b.

⛔ **The obvious lever is falsified** — `v_chunk constant integer := 5` is conspicuous, commented,
and **not** the cost; the loop's working set is only 515 rows. The cost is a **correlated latest-FMV
subquery carrying no partition key**, so it `Append`s across every `fmv_snapshots` partition (707 MB)
reading ~64 rows to return 1, **~147,000 times a day**.

`public.edition_fmv_current` already exists — a real 13 MB table keyed on `edition_id`. The fix is
one CTE.

### 🚨 …and my first form of that fix was WRONG. Please read this bit.

A random sample of 274 editions showed **zero value disagreements**, which appeared to license a
bare `COALESCE`. **That is the wrong population.** On the population the function actually serves —
697 editions changed inside its 30-minute window — `edition_fmv_current` **lags 33 of them (4.7%) by
up to 7.06 days**:

| edition | latest snapshot | cached | error |
|---|---:|---:|---:|
| `0e212d43…` | $11.00 | $4.50 | **−59%** |
| `34c86349…` | $117.00 | $163.00 | **+39%** |
| `acd48ef8…` | $74.00 | $49.00 | **−34%** |

Those would have gone straight into `wallet_moments_cache.fmv_usd` — **a displayed price** — and the
function's own `IS DISTINCT FROM` guard would not have caught one of them, because stale and correct
are both "distinct from what is there". **Your standing memory rule that `edition_fmv_current` is
for ordering and bulk aggregation only, never a displayed price, was right.**

⭐ **The fix survives, freshness-guarded rather than null-guarded.** The queue table already carries
the snapshot's `computed_at`, so:

```sql
RETURNING edition_id, computed_at            -- one extra column
...
LEFT JOIN public.edition_fmv_current efc
       ON efc.edition_id = e.id
      AND efc.computed_at >= p.computed_at   -- fast path ONLY when at least as fresh
```

**95.3% takes the fast path, with zero staleness surface** — provably correct, not merely faster.

⛔ **I did not ship it, and the reason is structural rather than caution:** the function carries a
DB-invariant pin (`supabase/tests/refresh_wmc_fmv_changed.sql`) and re-pointing a pin requires a
commit. **A pinned SQL function is push-gated.** That rule is now in CLAUDE.md, because it changes
what a no-push session should even attempt: the real levers are **pg_cron schedules, indexes, and
brand-new objects** — which is exactly what this session shipped, and nothing else.

**Your decision:** ship the freshness-guarded CTE + re-point the pin. Everything needed is measured.

---

## 5. Two retractions, both of which would have cost something

1. 🚨 **"`sales_2022`'s three indexes on an EMPTY partition" (filed 2026-08-23) is FALSE.**
   `count(*)` = **750,702** rows across all of 2022, and those indexes carry **43,815,424** scans
   (`sales_2022_nft_id_idx` alone 35.0M). It reported `n_live_tup = 0` because the partition has
   `n_tup_ins/upd/del = 0` and has **never been analyzed**, so the estimate was never set.
   ⭐ **`n_live_tup` is an estimate, and on a never-analyzed relation it is indistinguishable from
   empty.** Dropping those would have hurt.

2. 🚨 **My own `COALESCE` recommendation** — §4 above.

ⓘ Also corrected: *"reachability is per-index and only an EXPLAIN settles it"* is replaced by a
decidable rule (in `database.md`), and all six partial indexes of that shape are classified —
**5 reachable, 1 not**. The 08-23 filing's worked example (`idx_sales_2026_top_sales_board`
"unreachable today") is refuted: it is reachable, via the inner join in `v_insights_top_sales`.

---

## 6. Git push — the answer, and it is not what the error implies

You asked me to keep looking. **Diagnosed to the layer; not fixable from inside a running session.**

The decisive control, same session and same token:

| request | result |
|---|---|
| `GET https://api.github.com/user` | **200** — `{"login":"jamesdillonbond"}` |
| `GET .../repos/jamesdillonbond/rip-packs-city` | **403** |
| `GET .../repos/anthropics/claude-code` (unrelated, public) | **403** |

**The credential is present, valid, and yours.** It authenticates against an identity endpoint and
is refused on *every* repository endpoint including an unrelated public repo — so it is a
**per-repository allowlist applied ahead of the credential**, not a token problem. ⭐ Run
`GET /user` first next time; it ends the "is the token missing/expired/wrong-scope" branch in one
request.

**Tested and ruled out:** the device VM (it *can* now reach github.com and `git fetch` works, but it
has no credential helper and no `gh` — and it is not your Windows box); an `add_repo` tool (the
proxy's own error names one; it does not exist in this session). ⛔ I did not try to route around
it — the proxy README and CLAUDE.md both forbid that, and a previous attempt burned a real PAT.

⚠ **Your Project's GitHub sync is a different system** — a read-only knowledge connector with no
relationship to the git proxy's authorized set. Its presence is what makes this look like a bug.

**The fix is at session creation.** Start the session repo-attached:
`https://claude.ai/code?repositories=jamesdillonbond/rip-packs-city`, or `claude --cloud` from
inside the repo, or run the task on your computer. `/web-setup` in a real terminal fixes the *next*
session. Upstream `anthropics/claude-code#76248` is still open.

ⓘ **One capability claim in project memory was stale and is now corrected:** `device_bash` no longer
has zero egress (example.com and api.github.com both answer 200; `git fetch` works). The failure
mode changed from *transport* to *credentials*, and those look nothing alike.

---

## 7. Small things left deliberately undone, so they are not lost

- **`MEMORY.md`'s index needs three one-line touches** and I chose not to rewrite a 52 KB file
  inline from a cloud session — the tool has no patch mode, and a prior session blanked it that
  way. The corrections are already authoritative in the topic files (whose `description` lines lead
  with them). The index lines: the CLAUDE.md headroom figure (now **39,997 / 3**), the
  `cloud-bash-selective-external-egress` line (still says `device_bash` has **NONE**), and a new
  entry for `sample-the-population-the-code-touches.md`.
- **Four `ON CONFLICT DO UPDATE`s carry no change-detection predicate** —
  `roll_pack_ask_hourly_low` (305k blocks dirtied/day), `upsert_pack_ask_state` (**385 MB of WAL a
  day to maintain a 4 MB table** — the worst ratio on the instance), `apply_sales_counterparty`,
  `refresh_wmc_fmv_drift_active`. Mechanical fixes; two of the four are pinned.
- **jobid 303 and `/api/wmc-fmv-populate` drain the same `rwfc_state` queue on two independent
  schedules.** Which is the intended owner is a decision; removing the wrong one loses propagation.
- **jobid 16 (`rpc-backfill-pack-pool`) returns `processed:3, ok:0, fail:3, poolRows:0` every tick,
  288×/day** — the wedged-head filing, observed live tonight. Cadence is a lever *only* once you
  accept the head stays wedged.
- **The two 0-scan pack-sales-history indexes were NOT dropped**, because the six-source caller rule
  cannot be completed while both writers live outside the repo. The cadence cut already removes ~80%
  of what they cost.
