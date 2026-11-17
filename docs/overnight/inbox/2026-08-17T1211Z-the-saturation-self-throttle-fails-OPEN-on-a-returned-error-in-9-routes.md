# The saturation self-throttle fails OPEN on a returned error — 9 routes, and it fails open exactly when it is needed

✅ **SHIPPED the same session — all 9 routes fixed, with a source guard and a
behavioural test. §5 below is KEPT because its reasoning was wrong in an
instructive way, not because it still applies. Do not read it as current.**

⚠ **§5's decisive argument was a COST ESTIMATE I never measured, and it was
wrong.** I claimed nine bespoke Supabase stubs would each need per-file
sequencing to make *only* the throttle read fail. They do not: **the throttle is
the first read and it RETURNS EARLY**, so on the failing path the route never
reaches another query and a blanket-error stub cannot be ambiguous. One
representative behavioural test plus a directory-driven source guard covers all
nine and any tenth. **I spent this session testing other people's unmeasured
claims and very nearly shipped a filing built on one of my own.**

⚠ **The fix also turned out to be uniform in a way §6 did not anticipate**: rather
than replicate each route's differing `logRun` arity, it `throw`s the returned
error into the `catch` the author already wrote — so both failure shapes share one
path and no per-route signature knowledge is needed.

⚠ **And the sweep proved its own point about half-done sweeps.** A scripted edit
matched 8 of 9 and **silently skipped `ufc-studio-sales-history-backfill`, which
names its constant `PIPELINE` instead of `PIPELINE_NAME`.** Only the per-file
occurrence assert caught it. That is why the shipped guard walks the tree instead
of naming routes.

Found while sweeping the `?? 0`-on-a-count class after the `stale-fmv-monitor`
fail-open fix (`36c1356f`). Same expression, same failure direction, different
subsystem — so it is the same class, but the severity and the right remedy differ
and it should not be lumped into that fix.

---

## 1. What the guard is

Nine `app/api/cron/**` routes open with a self-throttle: count other pipelines'
recent failures, and if the platform looks saturated, skip this tick rather than
add load. The measured shape is identical in all nine:

```ts
try {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { count } = await supabaseAdmin
    .from("pipeline_runs")
    .select("id", { count: "exact", head: true })
    .eq("ok", false)
    .neq("pipeline", PIPELINE_NAME)
    .gte("finished_at", since)
  if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) {
    await logRun(..., { skipped: "saturation", recent_fails: count })
    return NextResponse.json({ ok: true, skipped: "saturation", ... })
  }
} catch (e) {
  await logRun(..., false, ..., `throttle_read: ...`, {})
  return NextResponse.json({ ok: false, skipped: "throttle_error" })
}
```

## 2. The defect

**The `catch` fails CLOSED. The returned-error path fails OPEN.** Both are in the
same block, and the inconsistency is invisible unless you know that supabase-js
does not throw:

| how the throttle read fails | what happens | verdict |
|---|---|---|
| the promise REJECTS | `catch` → `skipped: "throttle_error"`, tick abandoned | **fails closed — correct** |
| supabase-js RETURNS `{ count: null, error }` | `?? 0` → `0 > THRESHOLD` is false → **the tick proceeds** | **fails open** |

The author's intent is unambiguous from the `catch`: an unreadable saturation
signal should stop the tick. A returned error is the shape supabase-js actually
produces for a statement timeout, so the branch that fires in production is the
one that fails open.

## 3. Why this is worse than it first reads

**The throttle read is most likely to fail precisely during saturation.** It is a
`count: exact` over `pipeline_runs` — the very table every pipeline is writing to
— on a 2 GB IO-throttled instance. So the guard is disabled exactly in the
condition it exists to detect, and the failure mode is self-reinforcing: the more
saturated the instance, the more likely every one of these nine routes decides the
platform is healthy and proceeds.

This is consistent with the observed behaviour recorded in CLAUDE.md, where
`golazos-sales-history-backfill` and `ufc-sales-history-backfill` DO log
`skipped: "saturation"` on some ticks (8 of 25 and 12 of 27) — so the guard
demonstrably works when the count succeeds. Nothing measures how often it silently
failed open instead, because a failed-open tick is indistinguishable from a
healthy one in `pipeline_runs`.

## 4. The sites

All nine are the identical one-line expression:

```
topshot-flowty-unmapped-drain:233            ⚠ schedule RETIRED 2026-08-16 — inert
ufc-studio-sales-history-backfill:318
pinnacle-studio-sales-history-backfill:368
golazos-sales-history-backfill:416
topshot-flowty-sales-history-backfill:376
ufc-sales-history-backfill:429
pinnacle-sales-history-backfill:295
allday-sales-history-backfill:558
topshot-sales-history-backfill:682
```

Measured: **0 of 9 destructure the error.**

## 5. Why it was ALMOST filed instead of shipped (superseded — see the header)

Not severity — it is real. Three specific reasons:

1. **It is a 9-route mechanical edit, and this repo's recorded failure mode is the
   half-done sweep.** The `|| 1` divide guard, the two `saved_wallets` loaders and
   the 15 OG cards were each fixed on one copy first. Doing this properly means all
   nine in one pass.
2. **The test cost is the real cost, and it is not uniform.** Each route has its own
   bespoke chainable Supabase stub whose `then` resolves every awaited builder to
   `{ count: 0 }`. Making *only the throttle read* return `{ count: null, error }`
   requires per-file sequencing, in nine differently-shaped stubs. Shipping the
   route change without those tests would leave nine cron routes altered and
   unpinned — worse than the defect.
3. **No false claim reaches a user.** Unlike the `stale-fmv-monitor` fail-open
   (which suppressed an integrity alert) or the health badge (which painted green),
   this one adds load during saturation. It degrades the platform; it does not lie
   to a collector. That ranks it below anything user-facing but above cosmetic.

## 6. The fix, ready to apply

Per route, treat a returned error exactly as the `catch` already treats a throw:

```ts
const { count, error: throttleErr } = await supabaseAdmin
  .from("pipeline_runs")
  ...
// An unreadable saturation signal is not an all-clear. The catch below already
// abandons the tick on a throw; supabase-js RETURNS this case, so it needs the
// same treatment or the guard is disabled exactly when it is needed.
if (throttleErr) {
  await logRun(..., false, 0, 0, 0, `throttle_read: ${throttleErr.message}`, {})
  return NextResponse.json({ ok: false, skipped: "throttle_error" }, { status: 200 })
}
if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) { ... }
```

⚠ **Do NOT "simplify" this to `count == null` instead of reading the error.** It
would behave identically today and for the wrong reason — the documented
`?? 0`-is-the-mechanism correction — and it breaks the moment a client returns a
count alongside an error.

⚠ **Do NOT raise `SATURATION_FAIL_THRESHOLD` or widen the 30-minute window as a
substitute.** Neither touches the failure path; the guard is not mis-tuned, it is
unreachable on one of its two failure shapes.

## 7. Checks worth running alongside

- `topshot-flowty-unmapped-drain` is schedule-retired (cron removed 2026-08-16), so
  it can be fixed for consistency or left with a note — but do not spend a test on it.
- Two files (`pinnacle-studio-…`, `topshot-sales-history-backfill`) contain **two**
  `const { count } = await supabaseAdmin` occurrences. Only one is the throttle read.
  **Match on the `SATURATION_FAIL_THRESHOLD` line, not on the count read**, or the
  edit lands on the wrong query.
