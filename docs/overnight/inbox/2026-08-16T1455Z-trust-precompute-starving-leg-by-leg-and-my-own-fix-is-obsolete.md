# The trust precompute is starving leg-by-leg — and the fix I filed 15 h ago is already obsolete

Cowork cloud. **Filed 2026-08-15 21:10Z. MATERIALLY REVISED 2026-08-16 14:55Z** — the trend
described below overtook the recommendation in under a day. **Read the revision first.**
Read-only throughout; nothing changed. DB/migration lane.

> ✅ **RESOLVED 2026-08-16 15:08Z (Claude Code, interactive).** The revised recommendation — one cron
> job per leg — was applied: jobids **324–331**, monolith **287 unscheduled**. Record + revert block:
> `supabase/migrations/20260816150800_audit_20260816_trust_precompute_split_into_8_leg_jobs.sql`.
> First split tick (`rpc-thp-leg-pinnacle-fmv-share`, 15:09:08Z) **succeeded in 132.1 s**.
> ⚠ This filing said the split was "Trevor's call" — it was shipped during a "work through the tree"
> session; back it out with the migration's revert block if you want to own that call.

---

## ⚠ REVISION 2026-08-16 — two things I wrote yesterday are now FALSE

**1. "18 of 19 rows are under 2 h old, so this is one stale leg, not a stale board."** That was
true at 21:10Z on 08-15. It is not true now. Measured 14:55Z on 08-16:

| written at | rows | which legs |
|---|---:|---|
| 08-16 **00:59** | 1 | leg 8 `impossible_parallel` |
| 08-16 **06:58–07:07** | 15 | legs 3–7 (`pack_ev`, `fmv_sanity`, `serial_supply`, `fmv_coverage` ×10, `board_liveness` ×2) |
| 08-16 **12:58** | 3 | legs 1–2 only (`panini` ×2, `pinnacle_fmv_share`) |

**Only 3 of 19 rows are under 8 hours old.** The board has gone from "one leg lagging" to "most
of it lagging" in fifteen hours. Anyone quoting yesterday's reassurance today would be wrong.

**2. "Split leg 8 onto its own job near 07:00Z, which has a demonstrated success record."**
**That slot no longer has one.** The 06:58Z tick was 6-for-6 across three days when I wrote
that; it has since **failed**, and so did 12:58Z:

| tick (UTC) | result | seconds | legs completed |
|---|---|---:|---|
| 08-16 00:58 | ok | 491 | **8 of 8** |
| 08-16 **06:58** | **timeout** | 600 | 7 of 8 |
| 08-16 **12:58** | **timeout** | 600 | **2 of 8** |

**Five of the last six ticks failed.** The only surviving slot is 00:58Z, and its runtime has gone
**63 s → 275 s → 501 s → 491 s** over four days — 82 % of the 600 s budget. On that trajectory it
fails within days, and then no tick completes at all.

**The real conclusion: the procedure no longer fits its budget at ANY hour.** Rescheduling is
dead as a fix — it just chooses which legs starve. The lever has to be the work itself.

**Revised recommendation — give each leg its own cron job.** The eight legs already
`COMMIT` independently (verified: 8 COMMITs in `prosrc`), so **nothing transactional binds them
into one procedure or one 600 s budget**. Eight staggered jobs, each with its own budget, means
a slow leg delays only itself instead of starving every leg behind it. That directly fixes the
progressive-starvation shape above — where the midday tick now dies after two legs and the other
six keep yesterday's values — and it costs no new logic, only scheduling. It does **not** fix the
underlying saturation, and should not be described as doing so.

---

## Original filing (2026-08-15 21:10Z) — mechanism, still accurate

### The board gained a 5th breach

CLAUDE.md records "4 breached" from a 12:30 PT 08-15 sample. Measured 14:00 PT: **5**. Re-measured
08-16 14:49Z: still 5, and `fmv_sweep_wedge_hours` is **climbing monotonically** —
**4.30 → 4.68 → 6.03 → 8.04** over ~24 h. Earlier readings called that arm oscillating; over this
window it is not.

| arm | 08-15 14:00 | 08-16 14:49 | breach_at |
|---|---:|---:|---:|
| `fmv_sweep_wedge_hours` | 6.03 | **8.04** | 3 |
| `public_board_slow_count` | 14 | 12 | 1 |
| `unmapped_resolution_backlog_max` | 258 | 258 | 100 |
| `panini_sale_price_capture_dry_days` | 18 | 19 | 3 |
| `trust_precompute_max_age_hours` | 13.78 | 13.86 | 13 |

### Mechanism: the most expensive leg is scheduled LAST, and each leg commits separately

pg_cron jobid **287**, `58 */6 * * *`, runs `CALL public.rpc_trust_health_precompute_refresh_p()`,
which calls eight legs in a fixed order with a COMMIT after each:

```
1 panini · 2 pinnacle_fmv_share · 3 pack_ev · 4 fmv_sanity ·
5 serial_supply · 6 fmv_coverage · 7 board_liveness · 8 impossible_parallel
```

Because every earlier leg has already committed, a tick killed at the 600 s statement timeout
leaves the legs it reached fresh and everything behind it carrying stale values. Leg 8 is backed
by `raise_impossible_parallel_circ()` — the instance's **#3 disk reader**, 45.4 GB / 39.7 h at a
**6.5 % buffer hit ratio and 1,223 MB per call**. The platform's third-heaviest read is scheduled
last, behind seven others, inside one shared budget.

⚠ **A different leg dies on different ticks**, so this is not one pathological query — it is the
whole procedure not fitting. Leg 8 is simply always downstream of wherever the budget runs out,
which is why it is the most-stale row every time.

### What NOT to do

- **Do not raise the 600 s timeout.** Same disk-IO budget as `fmv-recalc` (75 % of invocations
  killed on 08-14) and the insights board warms (4 of 6 failing per tick); a longer run holds a
  pooled connection longer on the instance that is already saturating. **Same root cause seen
  through a third instrument — not a third investigation.**
- ⚠ **The arm reads `max(age)` over ALL rows**, so one perpetually-failing leg pins it
  permanently red. That is the `ufc_fmv_stale_hours` cry-wolf fuse this repo has already paid for
  once. If the legs are split, the arm should report per-leg. *(Still OPEN after the 08-16 split —
  it is a view change, not a schedule change.)*

## Durable

**A filed recommendation has a shelf life, and a recommendation derived from a TREND has a short
one.** Mine named a specific time slot on the strength of a 6-for-6 record and was falsified by
the next tick. When the finding *is* that something is degrading, any fix that depends on the
current rate of degradation must be re-measured before it is acted on — the record of this repo
is that findings get picked up days later.
