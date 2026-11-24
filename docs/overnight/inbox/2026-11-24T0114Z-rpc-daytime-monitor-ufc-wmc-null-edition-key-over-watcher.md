# Daytime monitor candidate — UFC (ufc_strike) wmc null-`edition_key` crosses the snapshot watcher

**Filed:** 2026-11-24 (rpc-daytime-monitor, read-only sweep). **Priority:** LOW. **Not a breakage.**

## What

`rpc_ops_snapshot()` (generated 2026-11-24T01:05Z) surfaced a `wmc_null_edition_key` row for **ufc_strike**:

```
{"collection":"ufc_strike","total":155,"new_7d":155,"max_total":100,"max_new_7d":25,"wallets_7d":2}
```

So **all 155** `wallet_moments_cache` rows with `edition_key IS NULL` for UFC are new within the last 7 days, from **2 wallets**, crossing both the 09-29 `check_wmc_null_edition_key` watcher's `>100` total gate and its `>25` new-in-7d gate.

## Why it is only a candidate, not an alarm

- **No trust-health breach.** The continuous arm added 2026-11-10 (`topshot_wmc_null_edition_key_rows`, breach 1000, migration `20261110230853`) is **Top-Shot-only**; `topshot_wmc_null_edition_key_rows` reads 0 and `ufc_flow_revival_sales_30d` is ok. UFC has **no** continuous wmc-null-key arm, so the snapshot's `>100` watcher is the only thing that sees this, and it is a read a session takes, not an alarm (ledger 2026-11-10).
- **Context fits buildout churn, not a regression.** `ufc_strike` is the freshly re-opened Aptos collection (ufc-aptos-sales-ingest / -wallet-link / -holdings, standing up since ~11-15/16). An older reading had UFC wmc null-key at **0** (ledger 2026-11-10 §Integrity). 155 rows all < 7 days old from 2 wallets is consistent with wallet walks landing **ahead of** UFC edition-key resolution, the same shape as the 11-09 Top Shot null-key backlog (which drained on its own via the healer) — but on a collection whose edition mapping is still being built.

## Source

- `rpc_ops_snapshot()` → `wmc_null_edition_key[0]` (snapshot `generated_at` 2026-11-24T01:05:27Z).
- Prior art: ledger 2026-11-10 (TS 0→5,207 null-key spike, healer hard-capped 20/run, drained in ~11 days) and migration `20261110230853` (the TS-only trust arm).

## Risk read

LOW / read-only symptom. The only user-visible failure mode is if either of the 2 wallets renders its UFC holdings **without edition / player / FMV** (how the 11-09 TS backlog showed up for two saved whales). Worth a one-query confirmation; otherwise this is latent and self-draining if a resolver is working.

## Suggested action (night pass — NOT this read-only pass)

1. Confirm the 2 wallets and whether UFC holdings render blank for them (edition/player/FMV missing) — if yes, that is the real, user-visible item; if no, this is latent.
2. Check `max(created_at)`/age of the 155 null-key UFC rows and whether any UFC edition-key resolver/healer is draining them (the TS healer `topshot-wmc-null-key-heal` is TS-scoped). If the rows carry a resolvable moment/token id and a UFC resolver is keeping up, **leave it** — it self-clears.
3. If UFC has no resolver leg: consider extending the wmc-null-key healer to UFC and/or adding a `ufc_wmc_null_edition_key_rows` arm to `v_rpc_trust_health` (template: the TS arm in `20261110230853`). ⚠ Mind the lane budget (retire-one rule, baseline 318 jobs) — a trust arm is a view edit, not a new job, so it is budget-neutral; a new healer job is not.

**Revert:** n/a (filing only; no production change in this pass).

---

## 🔎 DIAGNOSED 2026-11-23 ~5:55 PM PT (Claude Code cloud) — not self-draining; LOW; fix designed, not shipped

- **Who:** 149 of the 155 rows are `0xfd6debe3815415c3` (walked 3:46 PM PT 11-23: `wallet-backfill-ufc` found 249, 100 already keyed). The other 6 are `0xe5492c968fb5d358` (11-19), still unkeyed after 4 days. **Neither is a saved/member wallet.**
- **Why they stay NULL:** two defects in the UFC enrichment chain.
  1. **Page 0 timed out.** Vercel 3:47:44 PM PT: `[ufc-enrich-chain] fetch failed wallet=0xfd6debe3815415c3: The operation was aborted due to timeout`, then `pages=0 enriched=0 done=false`. The caller's `AbortSignal.timeout(45_000)` (`lib/chains/flow/wallet-backfill-helpers.ts` `triggerUfcEnrichmentChain`) is shorter than one page: `enrich-ufc-wallet` runs 100 Flow scripts at concurrency 5.
  2. **Every run restarts at `start=0` over ALL the wallet's UFC rows in `moment_id` order, keyed or not.** A wallet whose first page is slow never reaches its unkeyed tail.
- **The drain it falls back to has no caller.** The edge function's own comment says a failed page leaves the wallet "to the drain cron", and `ufc-enrichment-drain` has had no caller since cron-job.org disabled it on 10-18 (E5 row). So these rows never heal.
- **Fix (for a session that can deploy edge fns via `.github/workflows/edge-fn-deploy.yml`):**
  - In `enrich-ufc-wallet`, select only rows with `edition_key IS NULL`, and page by a `moment_id > cursor` keyset rather than an offset (an offset over a set that shrinks as it is enriched skips rows).
  - Give the caller a timeout above one page (≤ 140 s, under the edge wall), keeping `wallet-backfill-ufc`'s 300 s `maxDuration` in mind.
  - Optionally, a UFC arm in `v_rpc_trust_health` (budget-neutral view edit, template `20261110230853`).
  - Not shipped tonight: impact is two non-member wallets on the legacy Flow UFC collection, and the paging contract change needs an edge deploy plus a caller change together.


## 🔧 FIX SHIPPED 2026-11-23 ~7:37 PM PT (`f04a8cd`, Claude Code) — drain verify owed

- Unkeyed-only keyset pages, 140 s page timeout, deadline inside the 300 s `maxDuration`. Edge deploy run `45320889742` succeeded ~7:40 PM PT.
- Read ~7:50 PM PT (Cowork, MCP): still 149 + 6 unkeyed; neither wallet walked since the deploy. Mark RESOLVED once both read 0 after a walk.

## ✅ RESOLVED 2026-11-23 ~7:45 PM PT (Claude Code, local box) — both wallets at 0 unkeyed

- One manual `wallet-backfill-ufc` call per wallet at ~7:40 PM PT, against prod deploy `dpl_J7Hn5Aj7…` (`f04a8cd`, READY) and edge `enrich-ufc-wallet` v66 (read-back clean).
- Vercel: `0xe5492c968fb5d358 pages=1 enriched=6 done=true`; `0xfd6debe3815415c3 pages=3 enriched=149 done=true` (50 per page, as designed).
- Outcome table (`wallet_moments_cache`, UFC): `0xfd6debe3815415c3` 0 NULL of 249; `0xe5492c968fb5d358` 0 NULL of 106.
- Not done (optional, budget-neutral): a UFC arm in `v_rpc_trust_health`. The snapshot's `>100` watcher still sees UFC.
- ✅ **Follow-up ~7:51 PM PT:** the optional arm is live: `ufc_wmc_null_edition_key_aged_rows` (`20261124035113`), UFC rows unkeyed > 1 h, breach 25. A planted-defect control read `25/BREACH`.
