# Handoff — 2026-09-22 daytime autonomous pass (Cowork cloud + laptop VM, 11:28 AM → ~4:30 PM PT)

**Push status:** every commit this pass landed on `main` through the laptop VM (`$HOME` clone + the `.rpc-git-cred` store helper), built and tested in the cloud clone first. ⚠ The cloud container itself cannot push — *"not in this session's authorized repository set"* — which is specific to **this cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager. **Commit files as usual.**

## Health verdict: GREEN, with one defect found and fixed

- Cron fleet on LARGE: 24 h `cron.job_run_details` **9,481 / 9,481 succeeded, 0 startup timeouts**; 6 h failure rate 0 / 2,359.
- Security: `check_public_security_invariants` 0 rows, anon-write surface 0, secdef drift `[]`, search_path drift `[]`, R118 blind handlers 0.
- `detect_stalled_pipelines`: only `topshot-active-listings-ingest` (the laptop had been asleep; it resumed 11:16 AM, browser mode, 0 skipped).
- Vercel 24 h: 19 error groups, all low-count. `[pack-detail] … read exceeded 5000ms` still fires a handful of times (7 / 6 / 4 …, 1–2 users, mostly 7–9 AM PT) on a calm instance (6–9 MB/s, 93–95 % cache hit). See watch item W3.
- Sentry isn't used any more (#34), so it wasn't read.

## Shipped

| # | What | Where | Verified | Revert |
|---|---|---|---|---|
| 1 | **AllDay pack EV: `get_fmv_for_editions` chunked under PostgREST's 1000-row cap; pool prune by run stamp** | `compute-allday-pack-ev` v59 (v10 source; the repo copy was reconciled by the Claude Code session, `ef84e5d`) | First run: editions_with_fmv 1,000 → 1,463, EV rows 18 → 23, pool errors 1 → 0; **the page cursor advances again** (it was stuck on page 1 for ~37 h) | redeploy v58 from `edge-drift-2026-09-22` rollback copy |
| 2 | Same class closed at every other call site; tree-walk guard added | Golazos v35 (deployed), TopShot pack-EV (source only, no caller), `/api/wallet-cost-basis`, `__tests__/get-fmv-for-editions-is-chunked-under-max-rows.test.ts` | Golazos 11:37 run ok, v3; planted defect reds 4 guard cases | `git revert a5ded5f1d`; Golazos → v34 |
| 3 | **#35 write half: `suppress_redundant_updates_trigger()` on both `*_pack_sales_history` tables** | migration `20260922193435` | `n_tup_upd` +0 for 20+ min post-ship (was ~1,000–1,400/min); walker kept writing `err:null` | `DROP TRIGGER trg_suppress_redundant_updates ON …` (both) |
| 4 | Zero-Yield: 2 correct zeros suppressed with on-chain positive controls | migration `20260922194626` | offenders 4 → 2 (the two alert lanes stay loud on purpose) | `DELETE … WHERE pipeline IN (…)` |
| 5 | Five Cowork skills refreshed; `rpc-surface-qa` brought into the repo + bundle guard; CLAUDE.md "Supabase (Pro, Small)" → Large | `docs/cowork-skills/*`, `CLAUDE.md` | bundles 11/11, docs-guard 157 files green, CLAUDE.md 39,952 chars | `git revert` |
| 6 | Ledger backfill: the 09-21 Small→Large verdict and the 09-20 job-44 rotation (both lived only in Project docs) | `docs/overnight/ledger.md` | swallowed-headings 3, future-dated 0 | — |

⚠ **I broke CI once and fixed it:** `9e17d91e6` (docs-only) moved a paragraph between a `<!-- retired-rule:allow -->` marker and the line it allows → "Docs-guard tests" red. Fixed in `06500b3a5`. After that I ran the docs-guard set locally before every docs push.

## Needs Trevor (decisions, not code)

1. **Deal alerts are nearly unable to fire on Top Shot.** Your two active subscriptions (Blazers rookie specials ≥25 % under FMV; Lillard Archive ≤ $0.60) have delivered nothing since 09-14. The gate is correct (an ask must be confirmed within 12 h), but only **1,485 of 13,154 Top Shot asks (11 %)** are that fresh. The median ask is **126 h old**, because Atlas is the only thing confirming Top Shot asks since `public-api.nbatopshot.com` died. The choice is widening Top Shot ask confirmation (more Atlas coverage) or accepting that alerts only cover about 11 % of editions.
2. **Candy MLB confidence fell from 78 to 27 HIGH+MEDIUM** (of 125 editions) between 09-19 and 09-22, while sales **rose** (87 / 154 / 60 a day). 90 of the 98 LOW editions have ≥7 sales in 30 days. They are LOW because of the **dispersion gate**: median CV is 0.50 and prices vary about 16× within an edition. The 09-19/20 flood of cheap sales (average $1.31) widened the price ranges. That is the gate working as written, but it's worth checking whether a Candy "edition" mixes rarity or parallel populations. I didn't ship anything here because pricing logic is off-limits to autonomous passes.
3. **Scheduled tasks.** The two disabled every-2-hours passes (`trig_018Ay…`, `trig_01AZz…`, disabled since 09-01, #55) should be deleted or re-enabled. They're dead weight as they are. The nightly pass is still running cloud-only without the repo attached: the 09-22 overnight flags only reached `main` because you landed them by hand. Recreating it device-bound, or with the repo attached, would let it push.
4. **Eleven legacy desktop-only Cowork dashboards** (the KPI ones `rpc-tracked-fmv-confidence` and `rpc-traction`, plus `rpc-live-health`, `rpc-qa-scorecard` and seven others last touched June–August). They can't be updated from a cloud session. The offer: consolidate them into one published "RPC Gate Board" (accuracy KPI + WAU + health) and retire the rest.
5. Still open from 09-21: jobs 22 / 25 / 27 / 29 hold literal keys (25 and 29 share one), and they need the de-literalise path.

## Watch items for the next pass

- **W1 (24 h exit of #3):** `n_tup_upd` on both pack-sales tables < 10 % of pre-ship; `n_tup_ins` keeps pace; `relallvisible/relpages` > 80 % after the next autovacuum. Falsifier: inserts stall ⇒ drop the triggers.
- **W2:** `get_pack_sales_history` baseline is **mean 195 ms, 141 blocks/call** (pgss, cumulative). Re-read after the visibility maps recover. The pack-detail 5 s timeouts may ease with them.
- **W3:** pg_net shows 55 s **DNS-resolution hangs** at 2–6 an hour since ~8 AM PT (the #122 class, low rate).
- **W4:** the AllDay pack-EV cursor must keep advancing, with distinct dists per hour well above 18.
- R1/R2 (autovacuum 0.1 → 0.02 on the pack-sales tables) are **withdrawn**. #3 removes the churn that made them look necessary. R3/R4 are still candidates.

## Triage of the 14 inbox filings from 09-19 to 09-21

Ten are resolved or were overtaken by the Small→Large resize. Still open and DB-only: the Golazos `pack_distributions` defaulted zeros (latent, not user-visible) and the pack-sales head-check (gated on a 24 h Large baseline).
