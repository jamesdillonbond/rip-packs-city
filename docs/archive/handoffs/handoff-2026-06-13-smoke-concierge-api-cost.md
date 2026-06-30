# Handoff 2026-06-13 — Stop the smoke test from burning Anthropic API credits on the live concierge

Cost fix. The smoke suite exercises the LIVE concierge (`/api/support-chat`, Claude Sonnet + 5-tool loop) on every tick, and that is the dominant consumer of the RPC product's `ANTHROPIC_API_KEY` (the Anthropic API Console — separate from Trevor's Max subscription). Route code → Claude Code.

## Evidence (measured 2026-06-13)

- `support_conversations` last 7 days: **753 total, 751 smoke (99.7%), 2 real.** Real user concierge traffic is ~2/week (pre-traction); essentially all concierge spend is the smoke test.
- smoke-test/route.ts makes **3 real concierge calls per run** — `/api/support-chat` probes at ~L1175 (Pinnacle collectionId routing), ~L1366 (Pinnacle "Goofy" name filter), ~L1425 (Top Shot "LeBron" name filter). The 4th probe (~L1479, graceful-degradation / synthetic Anthropic 4xx) does NOT make a real LLM call — it's the pattern to copy.
- The smoke suite runs frequently (~every 20-40 min by the conversation volume), so ~100-200 paid Sonnet+tool-loop concierge calls/day. Each re-sends the large concierge system prompt (5 tool defs + context) across the tool loop, so they're not cheap. That volume is the most likely bulk of the ~$25-every-few-days Console burn.

(Confirm exact attribution at console.anthropic.com → Usage, filtered to the RPC API key. If Claude Code usage also shows there, that's a *separate* issue — the terminal/Cowork is billing to API instead of the Max plan; fix that with `claude logout` then `claude login` using the Max credentials. This handoff only addresses the concierge smoke spend.)

## Fix (pick a + b; both are small)

**a. Move the 3 live-concierge probes off the per-tick smoke run.** Gate them behind a flag / dedicated cadence so the full LLM round-trip runs at most ~once/day (or only on deploy), not every 20-40 min. The rest of the smoke suite (security, FMV, public pages, pipeline checks) keeps running every tick — those are free. This alone cuts ~95% of the spend.

**b. For the per-tick regression coverage, assert the router directly — no LLM.** What these 3 probes actually guard is the tool/routing layer: `searchPinnacleDeals` collectionId routing + character/player name filtering (the file already imports `searchPinnacleDeals`). Call that layer directly in the per-tick smoke (no `/api/support-chat`, no Sonnet) to keep the regression guard without paying for the model. Keep one real end-to-end concierge call in the daily job (optionally on Haiku) to verify the full LLM path still works.

## Verify

- After deploy: `support_conversations` smoke rows drop from ~100-200/day to a handful (≤ the daily job's count).
- Console → Usage for the RPC key drops correspondingly over the next few days.
- The concierge regressions still fail loudly if the router breaks (test b) and the daily job still catches an LLM-path break.

## Guardrails

- Commit directly to main, no branches/PRs; PowerShell git; re-verify push count 0.
- Don't delete the concierge coverage — relocate/cheapen it. A broken concierge should still trip something daily.
- Claude Code's direct inspection wins — line numbers approximate.

End state: the smoke suite stops making ~100-200 paid concierge calls/day; the Anthropic API Console burn drops to near the (negligible) real-user level, and the regression coverage is preserved via the direct-router assertion + a daily end-to-end check.
