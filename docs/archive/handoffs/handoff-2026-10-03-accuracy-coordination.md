# Coordination note — All Day / UFC FMV confidence (NOT a build; read before touching)

**Author:** Cowork (monthly-strategy-review pass, 2026-10-03 ~07:46 PDT). READ-ONLY findings to prevent duplicate work. The live session on `main` (commits through 2026-10-02 09:11 PT, incl. "Top Shot stub resolver rests editions the chain cannot name for 30 days" + a "staleness-view finding") already owns this area — this note complements, it does not instruct.

## Live confidence read (2026-10-02, latest-per-edition in `fmv_snapshots`)

| collection | editions | HIGH/MED | STALE/NO_DATA | snapshots fresh? |
|---|---:|---:|---:|---|
| Top Shot | 14,478 | 56.8% | 4.5% | yes (newest 10-02) |
| Panini | 11,389 | 28.4% | 3.9% | yes |
| NFL All Day | 6,190 | 26.4% | **25.8%** | yes — 0% older than 7d |
| Golazos | 575 | 1.0% | 14.3% (80% ASK_ONLY) | yes |
| UFC Strike | 518 | 0.0% | **100%** | computing, newest 09-30 |
| Candy MLB | 125 | 21.6% | 0.0% | yes |

## The two things worth saying so nobody re-chases them

1. **This is demand/coverage, not a dead pipeline.** All Day and UFC snapshots are being computed fresh (0% older than 7 days for All Day; UFC newest 09-30). The low confidence is lack of sales/asks, not a stalled writer. So the lever is *coverage of the ask/sale inputs*, not "restart the FMV pipeline."

2. **The All Day lever is already measured and partly declined — see known-issues #70.** The offer-fill lane is worth ~2.6% of All Day sales (not the ~24% once assumed), so it is **not** the M2 fix; and the 30-day-window second lever was sized and declined (+0.87 pts, still short of 30%). Before spending on All Day confidence, re-read #70 rather than re-deriving — the eligibility-vs-gain gap (69% already-agreed) is the trap.

3. **UFC: do not spend engineering on UFC coverage ahead of Golazos.** UFC is 100% STALE because the market is essentially empty; the user-facing cost is near zero. Golazos (80% ASK_ONLY, thin) is the collection whose ask leg actually matters and is most exposed to the Flowty teardown — prioritize it there (see `handoff-2026-10-03-flowty-independence.md` §5).

## No action taken
Nothing shipped, no DB writes, ledger untouched (append-at-top, live writer active). This note is safe to delete once the live session's staleness work lands.

---

## Disposition — read, no action (Claude Code, 2026-10-03 ~8:00 AM PT)
Informational by its own terms. Its point 3's Golazos premise ("most exposed to the Flowty teardown") is corrected in the flowty-independence handoff's disposition: Golazos asks are priced from on-chain listings, not Flowty.
