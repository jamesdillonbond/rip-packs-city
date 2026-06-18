# Handoff 2026-06-18 — floor-serial 429 fix WORKS but now pegs the 300s maxDuration (silent-kill risk)

Plain text. Claude Code's direct file inspection wins over this doc. Follow-up on df513a7 (the concurrency-2 + retry/backoff 429 fix). Measured live on the first post-fix run.

## Measured (topshot-deal-floor-serials, 05:37Z run, post-df513a7)

The fix is a big win on coverage:
- `listings_found` **53 → 452**, `gql_errors` **388 → 139**, `throttled_giveups` 139.
- Deal-board serial coverage **54 → 469 / 591 (79%)** in one run (was ~9%).

But the run cost almost the whole lambda:
- `duration_ms` = **299,870** against `export const maxDuration = 300`. It finished with **130ms to spare.**

## The risk

The route fetches all ~591 deal editions (concurrency 2, each with up to-3 retries + backoff on 429), accumulates rows in memory, and does the **batch `upsert` + `log_pipeline_run` only AFTER the whole fetch loop** (route L157-191). Because the loop now consumes ~300s, any run that's marginally slower (a few more 429s, slower GQL) crosses `maxDuration`, Vercel kills the lambda mid-loop, and **the entire batch is discarded + nothing is logged** — a silent failure that loses the whole run's work (the invisible-maxDuration class CLAUDE.md flags). This run squeaking in at 299.87s means it WILL cross on a worse day.

## Fix (pick 1+2; both are small)

1. **Only process editions that need it, capped.** The route re-fetches all 591 every run including the 452 already done — wasteful. Select `WHERE low_ask_serial IS NULL` first (the remaining ~122), plus a rolling refresh of the oldest-`updated_at` N, capped (e.g. 200/run). With coverage already at 469/591, runs drop to ~60-90s.
2. **Flush incrementally, not one batch at the end.** Upsert every ~100 fetched rows DURING the loop (and update a running counter), so a maxDuration kill loses at most the last partial batch, not all 452. Move the `log_pipeline_run` to a best-effort that still fires what it has.
3. Optional — fail-fast on sustained 429: lower the retry count / shorten backoff so persistent throttling doesn't burn the budget (the 139 giveups already ate retry time).

## Verify

Next run `duration_ms` comfortably under 300,000 (ideally <120,000), coverage reaches ~591/591, and `gql_errors`/`throttled_giveups` stay low. The cron stays hourly @ :37 (don't raise frequency — still upstream-rate-limited).

## Note

Not urgent-urgent — coverage is already 79% and climbing, and a killed run just retries next hour. But the silent-kill + full-batch-loss is a real footgun worth closing before it bites.

## Resolution — SHIPPED 2026-06-18 (Claude Code)

All three fixes landed in `app/api/cron/topshot-deal-floor-serials/route.ts`:

1. **Capped, prioritized work set.** Targets are sorted NULL-`low_ask_serial` first, then oldest `updated_at` (rolling refresh), and sliced to `MAX_PER_RUN = 250`. The full deal set rotates through over a few hourly runs instead of re-fetching all 591 every run.
2. **Incremental flush.** Rows upsert in `FLUSH_EVERY = 100` batches *during* the fetch loop (`flush()` after each push; `flush(true)` drains the remainder after the workers finish), so a kill loses at most the last partial batch, not the whole run.
3. **Soft-budget break + fail-fast retries.** A `SOFT_BUDGET_MS = 270_000` check ends the loop with ~30s of headroom so the final flush + `log_pipeline_run` always run (no silent 300s hard-kill). `MAX_RETRIES` cut 3 → 2 so sustained 429s burn less budget. New `pipeline_runs.extra`: `deal_editions_total`, `budget_hit`.

Verify next run: `duration_ms` well under 300,000 (expect ~60–90s), `budget_hit:false`, coverage climbs toward 591/591 over the next couple runs. Cron stays hourly @ :37.
