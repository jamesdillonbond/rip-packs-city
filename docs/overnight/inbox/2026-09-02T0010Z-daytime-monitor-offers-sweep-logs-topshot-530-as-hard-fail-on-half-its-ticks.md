# Daytime monitor — offers-sweep classifies a Top Shot GraphQL 530 as a hard `ok=false` on ~half its ticks

**Run:** rpc-daytime-monitor, 2026-09-01 ~17:07 PT (evening tick). Health otherwise GREEN.
**Not a spell:** positive control at sweep time `io_wait=1 / active=2`; every duration below is interpretable.

## Observation (symptom, low priority)
`offers-sweep` shows **36 failed runs / 24h** in `pipeline_fails_24h` — the largest fail bucket in the snapshot. Drilling into the last 12h, the ticks alternate cleanly:

- ~half log `ok=true` with `extra.skipped = "upstream_outage"`, `last_error = "Top Shot GraphQL failed with 530 …"` — the graceful-skip path working as designed.
- ~half log `ok=false` with the identical `error = "Top Shot GraphQL failed with 530. Response body: <head><title>An error has occured</title>…"`, `extra.pages=0`, `offers_raised_from_chain=0`, `duration_ms ~4000`.

So the SAME upstream condition (Top Shot GraphQL returning a Cloudflare-style **530**) is rendered as a hard failure on some ticks and a graceful `upstream_outage` skip on others — a detection/ordering race in the sweep, not a distinct bug per failed run.

## Why it is low priority / no data impact
`edition_offers` max `updated_at` was **2026-09-02 00:07Z (~1 min before the sweep)** — offers data is FRESH despite the 530s. No accuracy or freshness regression; the only cost is that `pipeline_fails_24h` is inflated by ~18 rows that are really one upstream outage, which can mask a genuine offers-sweep failure behind the noise.

## Likely root & pointer
The 530s are **upstream** (Top Shot GraphQL). Note this connects to the open finding in `inbox/2026-08-30T1610Z-topshot-has-moved-to-atlas-and-atlas-is-reachable-from-the-database.md`: Top Shot has migrated to Atlas, so the legacy GraphQL endpoint `offers-sweep` still calls is increasingly flaky. Two independent angles for whoever picks this up:
1. **Instrument honesty (small):** treat a 530 the same on every tick — take the `upstream_outage` graceful-skip branch (`ok=true`, skipped) rather than logging `ok=false`, so a real offers-sweep failure is not buried. This is edge-fn/route code → needs a push (hand off; not night-pass auto-shippable).
2. **Durable fix (larger, Trevor/roadmap):** point `offers-sweep`'s Top Shot reads at the Atlas endpoint per the 08-30 finding.

**Suggested action:** no auto-ship. Record the offers-sweep 530-as-hard-fail as a symptom of the Top Shot→Atlas endpoint migration; fold into the 08-30 Atlas item rather than opening a new investigation. Re-derive the fail split before acting — it will vanish on its own the moment Top Shot GraphQL stops 530ing.
**Risk:** none to observe; the code fix is a push-gated route change (not night-pass class).

---

## ⛔ REFUTED 2026-09-01 ~17:4x PT (Claude Code, Trevor's box) — it is not a race, it is the breaker working as designed, and suggested fix #1 would DISARM it

**The observation is real and well-measured. The diagnosis and the recommended fix are both wrong, and
the fix would cause the outage it is meant to tidy up.**

### The alternation is arithmetic

`lib/pipeline/upstream-breaker.ts` is **half-open by construction**: one real failure buys a window;
inside it ticks skip; once it elapses the next tick makes a REAL attempt, which fails again if the
upstream is still down.

- `OUTAGE_BREAKER_WINDOW_MS` = **30 minutes** (`offers-sweep/route.ts:42`)
- observed tick gap = **exactly 20.0 minutes**, all 18 runs in the last 6 h

`ceil(30 / 20) = 2` ⇒ **exactly one real attempt per two ticks**. The observed sequence is perfectly
regular, with no jitter at all:

```
00:02 ok=true skipped │ 23:42 ok=false │ 23:22 ok=true skipped │ 23:02 ok=false │ 22:42 skipped │ …
```

**A race would not produce a period-2 square wave locked to the window/interval ratio.** The ~50/50
split *is* the design, and the ratio is the falsifiable prediction that confirms it.

### 🚨 Why suggested fix #1 is harmful

> *"treat a 530 the same on every tick — take the `upstream_outage` graceful-skip branch (`ok=true`,
> skipped) rather than logging `ok=false`"*

The breaker decides with:

```ts
const lastReal = rows.find((r) => !isSkipMarker(r))
if (lastReal.ok !== false) return { skip: false, reason: "last_run_ok" }
```

Skip markers are **deliberately excluded** when finding "the most recent real run". If the failing probe
reported `ok: true`, there would be **no failing real run to find**, the breaker would return
`last_run_ok` on every tick, and it would **never trip again** — turning 1 real attempt per 2 ticks into
a full-price attempt against a dead upstream on *every* tick, forever, with nothing recording that the
protection was lost.

The module's own header warns about precisely this: *"Skip rows are EXCLUDED when finding 'the most
recent real run'. Without that, the marker this breaker writes becomes the newest row, the next tick sees
a non-failure, and the breaker disarms itself after exactly one skip."*

⛔ **NO CODE CHANGE. The `ok=false` on every second tick is load-bearing** — it is the state the breaker
reads to know the upstream is still down.

### The residual concern IS real, and belongs on the observer

*"`pipeline_fails_24h` is inflated by ~18 rows that are really one upstream outage, which can mask a
genuine offers-sweep failure"* — that stands, and it is a good catch. But the fix is on the **reading**
side, not the writing side: the fail-bucket metric should exclude (or bucket separately) runs whose
`error` matches `CLOUDFLARE_ORIGIN_DOWN`, which is already an exported, tested signature built for exactly
this. Changing the writer to make the metric look nicer would destroy the signal the writer exists to
emit.

⭐ **The transferable point: when a pipeline alternates ok/not-ok with a suspiciously regular period,
compute `window / tick_interval` before calling it a race.** And a filing's suggested fix is a hypothesis
like any other — this one was measured against the code it proposed to change, and did not survive it.
