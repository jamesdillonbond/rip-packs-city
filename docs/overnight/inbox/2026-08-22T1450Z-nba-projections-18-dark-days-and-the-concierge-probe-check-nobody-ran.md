# Two dropped checks, executed: the concierge probe PASSES, and NBA projections has been dark for 18 days on zero arms

**Filed 2026-08-22 ~07:50 PT (14:50Z), Claude Code interactive. MEASURED against the live DB.
Nothing shipped to prod state — this is docs + register only. Both applies queued for tonight
(20:15Z / 21:15Z) were deliberately left alone; see §3.**

---

## 1. The concierge live-answer probe — the check that auto-disabled with its session, run at last

A `send_later` routine (`trig_017CHHJyX79WfmtkRuUQBHNn`, "check whether the concierge live-answer probe
fired on its new deterministic schedule") was due **2026-08-17 12:20Z** and never ran. Its
`ended_reason` is **`auto_disabled_session_gone`** — the self-bound-routine failure mode the 08-22
ledger entry describes, caught here as a second live instance. The check itself was never performed by
anyone, so the concierge's positive control has been unverified for five days.

**VERDICT: PASS.** The concierge has a working automated positive control today.

`support_conversations WHERE is_smoke_test`, real answers = `category <> 'concierge_unavailable'`:

| day | real answers | first | last |
|---|---|---|---|
| 08-17 | 4 | 09:08:17Z | 09:08:18Z |
| 08-18 | 3 | 09:08:23Z | 09:08:46Z |
| 08-19 | 8 | 09:08:19Z | **13:05:08Z** |
| 08-20 | 5 | 09:08:17Z | **13:07:34Z** |
| 08-21 | 7 | 09:08:17Z | **13:06:26Z** |
| 08-22 | 4 | **12:57:04Z** | **12:57:11Z** |

⚠ **The bolded column is the pinned probe; the 09:08Z one is NOT.** Reading the 09:08Z cluster as the
fix working would have been wrong — that is the route's own **incidental** ~09:00–09:24Z fallback
window, i.e. exactly the non-deterministic behaviour commit `0807eb595` was written to replace. The
pinned probe is `.github/workflows/smoke-tests.yml`, `cron: '11 12 * * *'`, which appends
`?concierge=1` on any non-`push` event. Its scheduled runs land at **12:54–13:38Z** — ordinary GitHub
Actions schedule drift, confirmed against the workflow run list (144 scheduled runs; last six
12:55:53, 13:04:54, 13:05:53, 13:03:58, 13:03:10, 13:01:30Z). Matching those to the table above is what
identifies which cluster is which.

**Bounded honestly — what this does NOT say.** The pinned probe produced a live answer on **08-19,
08-20, 08-21, 08-22 (4 consecutive days)** and none on 08-17 or 08-18, so it became effective on 08-19
rather than on the 08-17 firing the routine expected. **I did not establish why**, and the two obvious
stories are both unproven: the workflow ran and succeeded on 08-17 at 13:01:30Z, and the only smoke row
in that window is a `concierge_unavailable` at 13:03:24Z. That row is **not** evidence of an outage —
`app/api/smoke-test/route.ts` sends `x-rpc-test-error-mode: credit_balance` and the degradation probe
writes an unavailable row *by design* on every run, which is why raw `concierge_unavailable` counts run
5–171/day and mean nothing on their own.

⛔ **So do not read a `concierge_unavailable` row as a concierge outage, and do not top up the Anthropic
key on the strength of one.** The measurement that carries signal is the *presence of a real answer in
the 12:54–13:38Z band*, not the absence of fallbacks.

**Two days in the trailing 14 have ZERO real answers — 08-15 and 08-16 — and they are NOT a defect.**
`0807eb595` landed 2026-08-16 12:24 PDT (19:24Z), so both predate the pinning. They are the old
incidental-window behaviour, which is the thing that was fixed. I flagged them as a finding first and
withdrew it on the commit date; recording the withdrawal because a "monitor went dark for two days"
claim would have been re-investigated by whoever read it next.

**Disposition: the routine's question is answered and the routine is obsolete.** It is already disabled
and cannot fire; left in place rather than deleted so the `auto_disabled_session_gone` evidence
survives.

---

## 2. `sync-nba-projections` — known-issue #8's numbers were a dated sample, and it got worse

The register (08-16) said *"failed 100% of its runs for 13 days"* and *"27.4 days stale"*. Re-derived
live 2026-08-22 — **both numbers are now wrong in the same direction**:

| | register, 08-16 | live, 08-22 |
|---|---|---|
| consecutive 100%-failure days | 13 | **18** (08-05 → 08-22 inclusive) |
| `nba_player_projections` staleness | 27.4 d | **32.8 d** (newest `last_synced_at` 2026-07-20 18:07Z) |
| rows | 485 | 485 (unchanged) |

`pipeline_runs_daily` over the trailing 20 days: **132 failed runs, 0 ok**, `last_error =
all_upstreams_failed` every day from 08-05. 08-04 is the mixed day (5 ok / 3 fail); 08-02 and 08-03 are
8-of-8 ok. `nba_players` is **174 rows, newest `created_at` 2026-05-07**.

### 🚨 The finding that changes what "fixed" means

**The `ok` days wrote nothing either.** 08-02 and 08-03 report **8 runs · 8 ok · `rows_written` = 0**.

This is CLAUDE.md's `rows_written = 0` null instrument caught live, in its **correct-and-broken**
reading: the pipeline was already producing zero rows while every instrument called it healthy.

Two consequences, and the second is the one that will bite:

1. **Restoring the upstream will not by itself refill the table.** This is the same slate-gated
   mechanism CLAUDE.md already records for `nba_players` ("restoring ESPN alone will NOT refill
   `nba_players`").
2. ⚠ **A fix must not be declared on `ok` turning true.** `ok` was true for 8 straight runs while the
   table gained nothing, so the acceptance test has to be **`max(last_synced_at)` moving**, never the
   pipeline's self-report.

⚠ **The season ended 08-04 and `ok` flipped on 08-04.** That correlation is worth testing and is **not**
a cause established here — stating it as one would be the "plausible mechanism is not a measurement"
trap. Both the seasonal story and the sports-proxy-403 story predict what is observed.

### The part that is actionable without an operator

The pipeline itself cannot be repaired from here — it sits downstream of the sports-proxy `403`, which
CLAUDE.md ranks as the highest-value open item and which needs a Cloudflare-egress deploy Trevor holds.
**But its silence can be made visible, and right now it is invisible by construction:**

- **0 of 102** `pipeline_cadence_watchlist` rows match `%nba%` or `%projection%` (83 of the 102 are
  active).
- `detect_stalled_pipelines()` returns **nothing** for it.

So the 18 dark days produced no alert **by construction, not by oversight** — the same shape as the
`is_active` blind spot and the `prosecdef` blind spot already in CLAUDE.md's guards section. An arm is
a small migration and is the cheapest honest improvement available on this item.

⚠ **Design the arm against the OUTCOME table, not the pipeline's self-report** — an arm watching
`ok`/`rows_written` would have read **green through 08-02 and 08-03**, the two days that prove the
instrument lies. Watch `max(last_synced_at)` on `nba_player_projections`.

⚠ **And size its `breach_at` deliberately before shipping it:** the table is *expected* to be stale out
of season, so an arm calibrated on in-season cadence will breach every summer and become another
crying-wolf arm like `panini_sale_price_capture_dry_days`. **Not shipped here for exactly that reason —
it needs a calibration decision, and a badly-calibrated arm is worse than no arm.**

---

## 3. What was deliberately NOT done

Two migrations are committed-but-unapplied and **already armed as fresh-session routines for tonight's
healthy window** — the cross-collection lock-window fix at **20:15Z** (`trig_01L4TBXNYcUAqYDC4h4pDwkR`)
and the `refresh_wmc_fmv_changed` temp-build at **21:15Z** (`trig_01EVvkWjY5WSJbb6sq6aDioJ`). Both were
left alone.

⚠ **This session ran at 14:26Z — squarely inside the measured 01:00–19:00Z degraded band** — and
`apply_migration` costs a ~10–20 s burst of user-facing `PGRST002` 500s. Applying either now would have
paid that burst inside the bad band **and** duplicated a scheduled apply. Re-verified live rather than
assumed: `cross_collection_cohort_mat` still reads **179 rows, `computed_at` 2026-08-17 04:10Z (5 d
10 h stale)**, migration `20260822013000` **not** in `supabase_migrations.schema_migrations`, jobids 60
and 4 still on `10 4 * * *` / `25 4 * * *`. The escalation stands exactly as filed; nothing here
supersedes it.
