# pack-EV / `fmv_current`: the LATERAL fix is verified equivalent — and the fixture-preserving alternative is refuted

Filed 2026-08-18 07:10 PT (14:10Z). Continues
`inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`, which measured the
~3,100x blowup and listed a lateral accessor as candidate fix A, unmeasured.

**NOT SHIPPED.** Three reasons, stated so nobody reads this as a queued no-op:

1. `compute_pack_ev_per_edition_weighted` is pack-EV — off-limits for autonomous change.
2. The lateral forces a change to a PINNED test's FIXTURE, and that change alters what the pin
   covers. That is a judgment call for Trevor, not a mechanical edit (section 3).
3. Everything here was measured inside a saturation spell (69% of active sessions in IO wait, an
   hour-long `autovacuum: VACUUM public.wallet_moments_cache`). Buffers are comparable; **wall
   times from this window are not**, and I have not quoted any as if they were.

## 1. What is now PROVEN about the lateral rewrite

The proposed shape, replacing the `pool` CTE's `LEFT JOIN fmv_current`:

```sql
LEFT JOIN LATERAL (
  SELECT fs.fmv_usd, fs.collection_id
  FROM fmv_snapshots fs
  WHERE fs.edition_id = pdp.edition_id
  ORDER BY fs.computed_at DESC
  LIMIT 1
) fc ON fc.collection_id = pdp.collection_id
```

**Equivalence is structural, not hopeful.** `fmv_current` is verified from `pg_views` as
`SELECT DISTINCT ON (edition_id) ... ORDER BY edition_id, computed_at DESC` — one row per
edition_id, with **no further tiebreak and no WHERE**. So the original is exactly
"top-1 by computed_at per edition, THEN require collection match", and so is the lateral. The
collection predicate stays in the `ON` clause precisely so it applies at the same point.

Three checks, all positive:

| check | result |
|---|---|
| ordered-`Append` returns the true global max (not a per-partition artifact) — all 3,097 editions of dist 4184, `LIMIT 1` vs `max(computed_at)` | **0 mismatches**, 3,097/3,097 have snapshots |
| value equivalence vs the REAL view (40-edition literal-array shape, dist 1019) | `fmv_current` → 40 rows / 1 collection / **sum 85.4400**; lateral → 40 / 1 / **85.4400** |
| cost, same saturated window, same instrument | old shape **killed at 55s**; lateral **completed**, `shared hit=17258 read=1508` = **18,766 buffers** vs the 08-16 filed **1,046,192** |

The plan is `Nested Loop Left Join → Memoize → Append` of three per-partition index scans on
`fmv_snapshots_<year>_edition_id_computed_at_idx`. That index already exists on every partition;
**no new index is needed.** (Memoize showed `Hits: 0, Misses: 3097` — every pool edition is
distinct, so memoization buys nothing here. Not a defect, just not a saving.)

⚠ 6,194 of the 18,766 buffers (**33%**) are spent probing the **empty `fmv_snapshots_2027`
partition** 3,097 times. Do NOT "fix" that with a `computed_at` bound — that changes semantics
(an edition whose latest snapshot is older than the bound would silently lose its price). Note it
is the same pruning idea the 08-16 filing correctly killed for the OLD shape, where it was worth
~2 buffers of 1,046,192. It is worth ~33% for the NEW shape. Same idea, different order of
magnitude, and it is still not free.

## 2. REFUTED: the fixture-preserving `= ANY(v_ids)` alternative

I designed what looked like a strictly better fix — keep reading `fmv_current`, but pre-filter it
to the pool's edition ids, reusing the `= ANY(array)` shape `/api/fmv` already runs at 335
buffers. Its appeal was that it touches **no fixture at all** (section 3 would evaporate).

Built it as a throwaway probe (`zz_probe_pack_ev_pushdown`, since **dropped** — verified 0
remaining). It **timed out at 55s on dist 4184, exactly like the original.**

Then plain `EXPLAIN` (free — it does not execute, the right instrument in a saturation spell)
showed the pushdown is **not** fenced. With a 3-element array:

```
Index Cond: (edition_id = ANY ('{...}'::uuid[]))   -- on all three partitions
Unique -> Merge Append   (cost=0.70..218.88 rows=187)
```

So `DISTINCT ON` is **not** an absolute optimizer fence for this predicate — a correction to the
08-16 filing's framing. **Leading explanation (UNCONFIRMED): a cost crossover.** 3 ids estimate
187 rows; scaled to 3,097 ids that is ~193k, which exceeds the cost of materialising all ~26k
editions once, so the planner flips to the full scan. It fits every observation — `/api/fmv`
chunks at **500** ids and is fast; pack-EV pools run **1,300-3,100** and are not — but I did not
EXPLAIN a 3,097-element array, so **this is a hypothesis, not a measurement.**

**Consequence:** if the crossover is real, a chunked `= ANY` (≤500 per batch, like `/api/fmv`)
would also fix this WITHOUT touching the fixture. That is a genuine third option and it is
unmeasured. Settle the crossover before choosing between it and the lateral.

## 3. ⚠ NEW TRAP — the pin's fixture models a state `fmv_current` CANNOT produce

This is the real blocker, and it would have bitten whoever shipped the lateral.

`supabase/tests/compute_pack_ev_per_edition_weighted.sql` stands `fmv_current` up as a plain
table and seeds it:

```sql
-- fmv_current is a CURRENT view: exactly one row per (edition, collection).
INSERT INTO fmv_current VALUES (eA,ts,10),(eB,ts,100),(eA,other,10),(eB,other,20);
```

**That comment is wrong, and the seed is impossible.** The view is `DISTINCT ON (edition_id)` —
one row per **edition**, not per (edition, collection). `eA` cannot simultaneously carry a TS row
and an OTHER row. Assertions **D3** and **D6** (the non-TS collection cases, including the
`ev_basis = 'original'` path) depend on that impossible second row.

Because the lateral reads `fmv_snapshots` rather than `fmv_current`, the fixture must become an
`fmv_snapshots` stand-in carrying `computed_at` — at which point the impossible row cannot be
expressed, and D3/D6 must be re-seeded onto **distinct** edition uuids per collection. That is
not a mechanical port: it changes what those two assertions cover.

⚠ **Production behaviour is unaffected either way** — old and new are identical there, since both
reduce to "top-1 per edition, then filter collection". The divergence exists ONLY inside a
fixture that models a state the view cannot emit. But per the standing rule that a test pinning a
behaviour is what holds that behaviour in place, **re-seeding a pinned invariant is Trevor's
call.**

Open and unmeasured: **does any edition actually carry snapshots under more than one
collection_id?** If yes, the OLD code has been silently dropping the non-latest collection's price
all along — a real (pre-existing) defect, not one this change introduces. I tried twice to measure
it (all pool editions, then a 1-in-40 hash sample) and **both timed out** under the spell. It is
cheap in a quiet window and it should be run before either fix ships.

## 4. Ready-to-apply change (NOT applied, NOT committed as a migration file)

Deliberately described here rather than dropped into `supabase/migrations/`: a
committed-but-unapplied migration would put the repo and the DB out of step and turn
`npm run db:pins:check` red, which is the documented "committed but UNAPPLIED" staleness trap.

The change is confined to the `pool` CTE of `compute_pack_ev_per_edition_weighted`; every guard,
clamp, coverage denominator and returned field is untouched. Shipping it requires, in one commit:

1. the migration (`CREATE OR REPLACE FUNCTION` with the lateral `pool` CTE),
2. the re-seeded fixture + verbatim DDL copy in
   `supabase/tests/compute_pack_ev_per_edition_weighted.sql`,
3. the `migration:` name repointed at `__tests__/db-invariants-drift-guard.test.ts:170`.

⛔ Do NOT `CREATE OR REPLACE VIEW fmv_current` as part of this — it carries
`reloptions = {security_invoker=true}`, re-verified 08-18, and a replace with no `WITH` clause
strips it. The fix is entirely caller-side; the view is not touched.

## 5. What this is worth

jobid 71 (`rpc-backfill-historical-pack-ev`, `13 * * * *`, `cron_heavy`): 7d = 155 ok / 13 failed,
of which **10 are `statement timeout` averaging 601s** inside this exact leg — **~100 min/week of
`cron_heavy` producing zero rows**, on the instance whose IO budget is the platform's number-one
problem. The lever the focus file names is cutting work, and this is the largest measured single
piece of pure waste currently identified.

---

## 🔁 BOTH OWED MEASUREMENTS DISCHARGED 2026-09-01 ~23:5x PT, in a quiet window — and section 2's MECHANISM is refuted

Full write-up:
[`2026-09-02T0700Z-pack-ev-the-two-owed-measurements-are-done-and-one-refutes-the-refutation.md`](2026-09-02T0700Z-pack-ev-the-two-owed-measurements-are-done-and-one-refutes-the-refutation.md).
Positive control at measurement time: **4 active backends, 3 in IO wait, longest query 4 s.**

- **Section 3's open question — "does any edition actually carry snapshots under more than one
  `collection_id`?" — is answered: ZERO**, over all 1,384,957 rows / 27,179 distinct editions. So the
  feared pre-existing defect does not exist, and the coverage a fixture re-seed gives up is coverage of
  a state production has never held.
- ⛔ **Section 2's "leading explanation (UNCONFIRMED): a cost crossover" is REFUTED.** Plain `EXPLAIN`
  at 3 / 100 / 500 / 1,000 / 1,500 / 3,097 ids keeps the identical plan with the `Index Cond` intact on
  all three partitions, and the cost grows **sub-linearly**. The plan never flips. The 55 s timeout was
  **the spell**, which this filing's own point 3 warned was not usable for wall times.
- **The conclusion survives; the reasoning did not — and the third option dies with it.** Executed warm:
  `= ANY(3,097)` costs **256,030 buffers / 619 ms** against the lateral's **18,657 / 265 ms**, and its
  cost is **LINEAR in the id count** (500 → 43,648 · 1,000 → 85,067 · 3,097 → 256,030). **Chunking at
  500 buys nothing.** The mechanism: `= ANY` prunes which EDITIONS are read but not which SNAPSHOTS —
  `DISTINCT ON (edition_id)` still reads each matched edition's whole history (mean **50.9** snapshots
  per edition) before Uniquing it.

👉 **A pushdown that selects rows but not VERSIONS is not a fix for a latest-per-key view.**
