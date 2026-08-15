# `remap_topshot_realign_miskeyed_subeditions` is SCAN-bound, so the filed p_limit fix is a no-op

**Filed 2026-08-15 ~16:50 PT (23:50Z) by Claude Code. Not taken: the repair is a migration on
TopShot keying, which every edition-keyed FMV derives from.**

## The claim being corrected

`docs/audits/deep-audit-register.md` R7 prescribes:

> **Fix is one constant per step** … apply it downward, 8000 → ~1000 (the size `catalog` proves
> fits at 10.8 s), then walk up from `step_ms`.

That is correct for `remap_topshot_split_resolved_subeditions` and **wrong for
`remap_topshot_realign_miskeyed_subeditions`**. Applying it to realign would change nothing, and
"nothing changed" would read as the whole reorder having failed.

## Measurements (2026-08-15, live; every probe rolled back, nothing committed)

Each probe ran the real function inside a `DO` block that `RAISE`s after timing it, so the work is
performed and then discarded.

| function | p_limit | result |
|---|---|---|
| `remap_topshot_split_resolved_subeditions` | 100 | **13,946 ms**, `{wmc_split:74, sales_split:42, moments_split:1}` |
| `remap_topshot_split_resolved_subeditions` | 500 | **27,930 ms**, `{wmc_split:494, sales_split:1, moments_split:8}` |
| `remap_topshot_realign_miskeyed_subeditions` | **100** | **`57014` statement timeout — never built its candidate set** |

Split fits `t(n) ≈ 10,450 ms fixed + 34.96 ms/row`, so 8000 predicts ~290 s — which is exactly why
the 08-15 tick recorded `split: 125,250 ms` and rolled back. **1000 predicts ~45 s.** Shipped.

Realign does not have a rate, because it does not get far enough to have one.

## Why p_limit cannot bound realign

The cancel names the statement. Its candidate build is:

```sql
CREATE TEMP TABLE _realign ON COMMIT DROP AS
  SELECT DISTINCT cur.nft_id, cur.base, …
  FROM (
    SELECT m.nft_id, … FROM moments m JOIN _sub_ed se ON se.id = m.edition_id WHERE m.collection_id = v_ts
    UNION
    SELECT s.nft_id, … FROM sales s  JOIN _sub_ed se ON se.id = s.edition_id WHERE s.collection_id = v_ts
    UNION
    SELECT w.moment_id, … FROM wallet_moments_cache w WHERE w.collection_id = v_ts AND w.edition_key ~ '::'
  ) cur
  JOIN topshot_moment_subeditions sub ON …
  JOIN editions tgt ON …
  WHERE cur.cur_ext <> (…)
  LIMIT greatest(1, p_limit)
```

The `LIMIT` is the **last** operator, applied after a `SELECT DISTINCT` over a `UNION` (itself a
dedupe) of three full TopShot scans — `moments` ~292k, plus `sales` and `wallet_moments_cache`.
Postgres must materialize that before it can trim it, so the limit trims the *output* and never the
*work*. **Cost is constant in `p_limit`.**

⚠ **Therefore a smaller p_limit is strictly worse here: identical cost, less work done.** That is the
opposite of the filed prescription.

⚠ **The same tell was already in the payload the register quotes and was read past:**
`seed_knot_occupants` hit the identical ~120 s ceiling at a `p_limit` of **200**. A tiny cap hitting
the ceiling is the signature of scan-domination, and it was visible before any new measurement.

## The ceiling is the GLOBAL timeout, not the function's own

Worth recording because the register reasons about which timer binds:

- `remap_topshot_split_resolved_subeditions` and `remap_topshot_realign_miskeyed_subeditions` both
  declare **`statement_timeout=300s`** in `proconfig` — *not* the 120 s the register states.
- `pg_settings.statement_timeout` = **120000**, source = configuration file.
- `service_role` = 30 s, `authenticated`/`authenticator` = 8 s, `anon` = 3 s, `cron_heavy` = 600 s.

Split died at ~125 s: not 30 s, not 300 s. **The global 120 s bound it**, so the declared 300 s is
inert — another instance of [[function-statement-timeout-is-inert]]. `STEP_WORST_MS = 121_000` in
the route is therefore the correct constant, for a reason the file did not previously state.

## The actual repair (NOT taken)

Bound the **driving side** rather than the output: drive from `topshot_moment_subeditions` (the
small side — it holds only resolved sub-edition rows) with the `LIMIT` applied *before* the union
and joins, then join out to `moments`/`sales`/`wmc` per candidate `nft_id`. That makes `p_limit`
genuinely bound the work and lets the step be tuned like split.

**Why it is filed and not shipped:** it rewrites the candidate semantics of a TopShot re-keying
function. Every edition-keyed FMV on the platform derives from that keying, and the repo's own rule
is that the remap/conflation family is not a casual-refactor target. It also wants a DB-invariant
pin (the family is 9-of-9 pinned as of 2026-08-15) and a byte-comparison of before/after candidate
sets on a quiet instance — none of which belongs in a tuning pass.

## What NOT to conclude

⚠ **Do not read "realign still missing from `extra.step_ms`" on the next tick as the reorder having
failed.** Split and realign fail for different reasons; only split's was a tuning problem, and only
split's is fixed. Knots is predicted to run either way (it is reached at ~261 s against a 471 s
start-cutoff).

⚠ **Do not skip realign.** It is not permanently broken — the 2026-07-31 run completed with all four
keys present, so it succeeds in a quiet window. Skipping it deletes a real correction path (the
wrong-circulation moment-page display) to save time it only sometimes spends.
