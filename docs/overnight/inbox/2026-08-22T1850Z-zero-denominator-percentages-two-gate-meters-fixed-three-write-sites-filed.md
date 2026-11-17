# The zero-denominator percentage family: two gate meters fixed, three write-sites filed rather than changed

**Filed 2026-08-22 ~11:50 PT (18:50Z), Claude Code interactive. Two fixes SHIPPED, three sites deliberately NOT changed and this says why.**

---

## 1. The shape

CLAUDE.md names `?? 0` on a count and `|| 1` as a divide-guard as the fabricated-number shapes. This is
their sibling and it had not been swept:

```ts
const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0");
```

**A population of ZERO is not a share of zero.** The ternary looks like a safe divide-guard — it does
avoid `NaN` — but what it publishes is a *measurement*: `0%`. On a metric anyone acts on, "there is
nothing to measure" and "the measured value is zero" are different claims, and only one of them is a
reason to do something.

⚠ **Grep the EXPRESSION, not the file** — per CLAUDE.md, and it is why this was found at all: the
sentinel's confidence arm led to a repo-wide sweep for `d > 0 ? … : "0"` and its `|| 0` relatives.

## 2. SHIPPED — both roadmap gate meters

Both are in `app/api/sentinel/route.ts`, and both are metrics the roadmap steers by:

- **`FMV Confidence (canonical TS)`** — the headline metric. With a tally that returned no canonical
  *base* editions, `baseTotal` is 0, `pct` renders `"0"`, and the arm published
  `BASE HIGH+MED: 0%` plus `value: "0% base high+med"`. Read as an accuracy collapse. ⚠ Note the read
  did **not** have to fail for this: `data = []` is truthy, so a **genuinely empty** read took the
  success path — this is the "read ok + genuinely empty" state rendering as a measured zero, which is
  exactly the third state the canon separates.
- **`Edition Coverage`** — `liveEditions` is 0 when the RPC comes back without a `live`-scope row.
  Published `0 of 0 live editions … (0%)` and `value: "0%"`.

Both now withhold the number and say the share is **unmeasurable**, with `status: "warn"`.

⚠ **The copy deliberately says "not zero", not "not 0%".** First draft said `0%`, which forced the test
to carve a negative lookahead out of its own assertion so the fix's wording would not trip it. **A
carve-out added to tolerate the fix's own text is how a test stops pinning anything** — the wording
changed so the assertion could be strict (`expect(detail).not.toContain("%")`).

Pinned by two cases in `__tests__/api-sentinel-branches.test.ts`, both asserting the **absence of a
percentage** rather than the presence of a warning string. Negative control: both red against the
pre-fix route, 25 others green.

## 3. NOT CHANGED — three write-sites, and this is a decision, not an oversight

```
app/api/admin/backfill-badges-from-sets/route.ts:256   lock_rate_pct: owned > 0 ? … : 0
app/api/cron/allday-badge-ingest/route.ts:130,131      burn_rate_pct / lock_rate_pct
app/api/badge-sync/route.ts:385                        lock_rate_pct
```

These differ from the two above in a way that matters: they are **typed `number`, not `number | null`,
and they are WRITE payloads**, not display strings. Making them honest means widening the type and then
handling null in every consumer of the badge rows — a schema-shaped change, not a copy change.
⚠ **And the semantics may genuinely differ:** a badge nobody owns arguably has no lock rate rather than
a misreported one, but that is a product call about stored data, and CLAUDE.md puts ingest-route logic
off-limits for autonomous shipping. **Filed, not touched.**

⚠ **The correct pattern already exists in this repo** and is the model to copy:
`app/api/cron/data-integrity/route.ts:122` — `const overall = totEd > 0 ? Number(…) : null;`. So the fix
is known; only its blast radius is open.

## 4. What this does NOT claim

It does not claim the family is now swept clean — the grep covered `app/ lib/ components/` for
`d > 0 ? … : "0"` and `|| 0` percentage shapes and surfaced the sites above. It does **not** cover every
arithmetic guard in the estate, and no guard was written for this shape: unlike the two-state branch
banned the same day, this expression's population is **majority-correct**, so a ban would red correct
code and be switched off. That is the same "same expression, opposite correctness" split recorded for
the driver-message population.
