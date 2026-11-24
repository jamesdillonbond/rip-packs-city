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
