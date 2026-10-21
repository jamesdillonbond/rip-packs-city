# Daytime monitor — 2026-10-20T21:10Z (GREEN infra sweep)

## Candidate: `topshot_missing_fill_offers_walk` cursor rewound +9.4M blocks (2026-10-19 18:12Z) — establish deliberate re-seed vs cursor-write regression

- **Title:** `topshot_missing_fill_offers_walk` jumped forward 9,414,648 blocks (158,890,658 → 168,305,306) on 2026-10-19T18:12Z; `rewind_count`=2, lowest-observed position 130,890,658.
- **Source:** `rpc_ops_snapshot()` → `backward_cursor_rewinds` (deterministic instrumentation). Not present in `ledger.md` or the inbox as of this run.
- **Observed, NOT concluded:** the driving pipeline `backfill-offer-fill-sales` is GREEN every ~5h (latest ok 2026-10-20 19:24:10Z; 8/8 green in the last 30h), so the walk is **not wedged** and catalog freshness is not currently degraded. The instrumentation flags the forward jump specifically because this cursor has been observed walking DOWN (low-water 130.9M < pre-jump 158.9M), so an increase discards walk progress that nothing re-walks → a possible silent coverage gap over blocks ~158.9M–168.3M.
- **Risk read:** LOW–MEDIUM, not urgent (pipeline healthy). The two explanations are indistinguishable from state alone: (a) a deliberate re-seed — gap intentional, nothing to do; or (b) a cursor-write regression (the class `ee90eb54c` fixed 2026-09-02) — in which case blocks ~158.9M–168.3M hold un-ingested offer-fill sales to backfill.
- **Suggested action (night pass / Trevor):** establish re-seed vs regression before dismissing — inspect the cursor's write path for a recent change and check whether the 158.9M–168.3M range was already covered or needs a bounded re-walk. Do NOT revert the cursor. Sense-and-log only; no fix attempted this run.

## Drained 2026-10-20 — explained, no change
The +9.4 M "rewind" (158.9 M → 168.3 M at 10-19 18:12Z) is the ASCENT of the 10-19 morning dispatch: ~150 `backfill-topshot-missing-fill-offers` calls 8:00–9:42 AM PT walking up from the 130,290,659 re-seed, sampled mid-climb by the 2-hourly watermark observer. Same mechanism as the 10-19 2:40 PM PT ledger entry and the 10-19 focus.md steer ("do not re-file it"). Re-read ~8:00 PM PT 10-20 (Cowork cloud).
