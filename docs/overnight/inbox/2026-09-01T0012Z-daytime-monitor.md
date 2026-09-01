# Daytime monitor candidate — 2026-09-01T00:12Z (DB clock)

Tick: ~17:06 PT / 00:12Z. Lock RELEASED (night pass 08:12Z). Not first-tick-of-day, so 1a extras skipped.

## Sweep result: HEALTHY, with one elevated known-class trust arm worth a night-pass look.

Security invariants/secdef-anon/rls-off/anon-write all `[]`. `detect_stalled_pipelines` `[]`. `check_pgcron_recent_failures` `[]`. Vercel latest READY = `a6b3c4ab` (the two newer commits are docs-only, correctly CANCELED by ignoreCommand). Editions stable (ts 19,933 · nfl 6,190 · golazos 575 · ufc 518 · candy 125).

⚠ **Positive control shows a saturation spell: io_wait 16 / active 21 (76%).** Every duration read this tick is uninterpretable; findings below are SYMPTOMS, causes deferred to a quiet-window re-measure per Section 1c.

## CANDIDATE (low-risk, not on the Declined list, not recently ledgered)

**Title:** `topshot_impossible_parallel_serials` trust arm is BREACHing at **10** (breach_at 3) — elevated vs its usual 1–4 float.
**Source:** `rpc_ops_snapshot()` trust_health, 2026-09-01T00:06Z. Sentinel `sentinel_ts_uuid_editions_48h = 0` (no writer leak). `ts_uuid_dupes_created_24h = 0/ok`.
**Risk read:** LOW / display-only. This is the known self-healing `::`-cataloging straggler class (docs/archive/handoffs/handoff-2026-07-11-audit-followups.md): `::` sub-editions whose floor-seeded `circulation_count` sits below a real observed sale serial. The sales/deal/EV boards are unaffected — the sentinel watches the *sales* class and it is clean. It has hit 11 before (07-11) and cleared to 0 via a per-parallel circ backfill or a small `circ_floor_raise` migration.
**Why worth a look now:** it is higher than the July float and this is a genuine BREACH not on the standing do-not-flag list. It has not self-cleared to <3 on its own this tick.
**Suggested action (night pass, quiet window — NOT a conclusion):** (1) enumerate the current impossible `::` editions (`circulation_count` < max observed sale serial) and confirm count = 10; (2) verify whether the per-parallel circulation backfill is still reconciling stragglers or has stalled. **HYPOTHESIS ONLY, to verify not assume:** the GQL-authoritative circ backfill may be blocked by the ongoing `public-api.nbatopshot.com` 530 dead-host outage (still down — offers-sweep 36/36 failures this 24h all `Top Shot GraphQL 530`, newest 23:42Z). If the backfill is host-blocked, the stragglers cannot reconcile and the arm will keep drifting up until the Atlas/Studio migration lands or a `circ_floor_raise` wave is shipped. Do not ship a floor-raise from this spell reading — re-measure the exact set first.

## Known-class, NOT new (recorded so they are not re-raised)
- `public_board_slow_count` 6 (BREACH) — saturation collateral, standing do-not-flag.
- `unmapped_resolution_backlog_max` 255 (BREACH) — AllDay permanent floor; improved 338→255, do not raise threshold.
- `fmv-backfill` 41.7% / `price-snapshots` 27.3% pipeline_alerts — trailing 2-day windows already CLEARING (3 most-recent runs of each all ok; failures are older statement-timeouts). No action.
- offers-sweep 36 fails — Top Shot dead-host 530 behind the `c8ac905` breaker; operator-blocked (Atlas). sync-nba-projections 8 — D28, alerts suppressed, self-recovering.
- Sentry dark since 08-18 (#34), not re-probed.

## Deferred this tick (spell discipline)
Artifact deep payload validation not run — 11 artifacts in manifest; core objects (fmv_snapshots, editions, pipeline_runs, collections) already exercised by the snapshot, and rpc-live-health carries its own `active>=15 → NULL` spell guard. Re-validate in a quiet window.

---

## ✅ RESOLVED 2026-08-31 20:5x PT (Claude Code, Trevor's box) — cleared 36 minutes after this filing, and this filing's HYPOTHESIS IS REFUTED

`topshot_impossible_parallel_serials` = **0**, status `ok` (breach_at 3), on the live board.

Read from the arm's own precompute row rather than inferred: `rpc_trust_health_precompute` stamps
**value 0 at 2026-09-01 00:48:00Z** — **36 minutes after this filing's 00:06Z reading of 10.** The
per-parallel circ backfill reconciled the stragglers on its very next tick. Known self-healing class,
no action taken, and the `circ_floor_raise` lever was correctly not used.

### ⛔ The stated hypothesis is FALSIFIED — recorded so nobody inherits it

This filing said, explicitly flagged as *"HYPOTHESIS ONLY, to verify not assume"*:

> the GQL-authoritative circ backfill **may be blocked** by the ongoing `public-api.nbatopshot.com`
> 530 dead-host outage … If the backfill is host-blocked, the stragglers cannot reconcile and the arm
> will keep drifting up until the Atlas/Studio migration lands or a `circ_floor_raise` wave is shipped.

**That prediction is wrong, and the discriminator is clean.** The dead host is *still* 530 — the
09-01 03:00Z pass re-probed it twice against a `rest-mainnet.onflow.org` positive control in the same
second and recorded the sixth consecutive 530. **The host stayed down and the arm reconciled anyway**,
so the per-parallel circulation backfill does **not** depend on `public-api.nbatopshot.com`. Whatever
feeds it is a different source.

⭐ **Why this is worth the words:** the hypothesis was the kind that would have justified shipping a
`circ_floor_raise` wave — a write against source data — on the theory that self-healing was
structurally blocked. It was not blocked. **The arm's drift 1→4→10 was ordinary catalog lag, not
evidence of an outage-induced ratchet.** Flagging it as a hypothesis rather than a conclusion is what
made it cheap to kill; the next pass should keep doing that.

**Standing escalation condition (unchanged):** escalate only if the arm fails to fall below 3 across a
full circ backfill cycle. It cleared inside one.
