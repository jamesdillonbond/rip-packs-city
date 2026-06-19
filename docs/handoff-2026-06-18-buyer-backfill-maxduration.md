# Handoff 2026-06-18 — buyer-backfill STILL near the 600s ceiling after BATCH=150

Plain text. Follow-up correction to handoff-2026-06-18-audit-followups.md Item 1.

## What happened

Item 1 of the audit-followups handoff lowered topshot-buyer-backfill BATCH 200->150 (shipped d5f5f40) to bring the after() drain from ~577s to ~435s, clearing the 600s maxDuration lambda-kill ceiling. It did NOT work as predicted: the daytime monitor measured post-ship runs still at ~590s (latest 02:34Z 2026-06-19 = 589.8s, ~10s under the 600s cap; 2 of the last 8 runs within 2-10s of the cap).

Why: per-row on-chain decode latency rose (~2.9s -> ~3.9s/row), so PER-ROW LATENCY governs runtime, not batch size — 150 rows x ~3.9s ≈ 585s. Lowering the batch by 25% didn't help because the cost per row went up. The invisible-failure risk is unchanged: a run that tips over 600s is killed at the lambda ceiling BEFORE the finally block writes pipeline_runs, so it silently loses the batch and stalls recent-sales buyer resolution while reading as a "silent cron gap."

## Fix (file: app/api/admin/backfill-topshot-buyers/route.ts)

Two levers; do BOTH for real headroom that survives further latency drift:
1. BATCH 150 -> 100 (line 25). Runtime ≈ 100 x ~3.9s ≈ 390s — comfortably under 600 regardless of latency drift. Throughput stays fine: 100/run x ~10 runs/day = ~1,000/day, far above the ~270/day new-null inflow, and the historical tail is low-priority.
2. maxDuration 600 -> 800 (line 33). 800 is the Vercel Pro HARD cap (above it the deploy silently ERRORs — do not exceed). This is extra insurance, not a substitute for (1): at 800 a latency spike could still hit the ceiling, whereas BATCH=100 bounds the runtime directly.

The monitor's standing recommendation was maxDuration 600->800; pairing it with BATCH=100 is more robust because it attacks the runtime itself. TX_DECODE_DELAY_MS=40 (line 26) contributes only ~4-6s and can stay.

## Revert / verify

Revert: restore BATCH=150 + maxDuration=600. Verify: over the next ~12h, pipeline_runs for topshot-buyer-backfill log duration_ms comfortably under 600000 (target < ~450000), ok=true every run, and recent (7d) TS null-buyer count keeps falling.

## Guardrails

main only; PowerShell git; route-only change (no DB); maxDuration must not exceed 800 (Pro hard cap — invisible deploy ERROR above it).
