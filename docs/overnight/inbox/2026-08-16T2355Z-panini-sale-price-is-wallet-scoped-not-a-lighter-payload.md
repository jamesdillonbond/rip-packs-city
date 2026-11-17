# `panini_sale_price_capture_dry_days` is CRYING WOLF — it watches a field abandoned on 2026-08-08 while the live replacement works

**Filed 2026-08-16 16:55 PDT / 23:55Z, CORRECTED 17:2x PDT (Claude Code, read-only). Nothing shipped.**

> ## ⚠ CORRECTION TO THE FIRST VERSION OF THIS FILING — read this before the rest
>
> The first version of this file asked for a live A/B on the runner box and said *"on 2026-07-27 the
> runner began sending a wallet-scoped session."* **Both were wrong, and the real headline is
> different and more actionable.**
>
> 1. **The A/B WAS ALREADY RUN, on 2026-08-08** (commit `521ee89f`). It found `listType` **INERT** —
>    a nonsense control returned the same 10 rows / 10 nulls as all four real values — and that **a
>    fully signed request from Panini's own front end gets the same nulls we do.** Its conclusion:
>    *"No request-shape fix exists."* Asking for that test again was asking for finished work.
> 2. **"The runner began sending a wallet-scoped session" is unsupported.** The runner contains **no
>    Panini auth code at all** — its only `Authorization` header is our own `INGEST_SECRET_TOKEN` for
>    the ingest route; Panini requests are signed natively by the logged-in browser. The only runner
>    commits near the switch (`16a600e6`, `9bd991b3`, 2026-07-26) are a **DOM psku-harvest
>    enumeration fallback** that touches no auth, no headers and no navigation. **The change was
>    upstream, not ours.**
> 3. **THE ACTUAL HEADLINE: `brought_at_price` was deliberately abandoned and REPLACED on 2026-08-08,
>    and the replacement is working — but the arm still counts dry days on the dead field, so it
>    can never go green.**
>
> What survives from the first version, and is still worth having: the **key-set diff** (refutes the
> "lighter payload" reading the arm STILL names as leading) and the **wallet-scoping biconditional**
> (the mechanism, which the 08-08 A/B could not see because it varied `listType`, the wrong axis).

---

## 1. The replacement shipped 2026-08-08 and is healthy

`521ee89f` re-pointed sale capture at **`nftSalesData`**, whose `url_key` is byte-identical to
`panini_card_serials.sku`. The op does not fire on page load — it fires only when the SALES HISTORY
tab is activated, so the runner now clicks it and lets the SPA sign the request natively.

Share of newly-captured serials carrying a `last_sale_usd`, by capture day:

| day | captured | with sale price | % |
|---|---|---|---|
| 08-07 | 2,059 | 103 | **5.0** |
| **08-08** (replacement ships) | 1,672 | 148 | **8.9** |
| **08-09** | 4,241 | 963 | **22.7** |
| 08-10 | 11,634 | 2,837 | 24.4 |
| 08-12 | 6,626 | 1,399 | 21.1 |
| 08-15 | 690 | 212 | 30.7 |
| **08-16** | **17,809** | **4,073** | **22.9** |

Totals: **15,346** rows carry `last_sale_usd`, **18,753** carry `last_sale_at`, newest sale
**2026-08-16 21:16Z** (hours ago), **1,033** sales in the last 7 days.

**Panini sale-price capture is not dry. It is running at 21–39% and has been for 8 days.**

## 2. So the arm is the `ufc_fmv_stale_hours` failure mode, again

`panini_sale_price_capture_dry_days` counts consecutive capture days on which
`v_panini_serial_sale_field_supply` saw `raw_supplied_sale_price = 0` — i.e. it measures
**`brought_at_price`**, the field the 08-08 A/B proved unfixable and which we deliberately stopped
relying on.

It reads **19 and +1/day, forever**, because nobody intends to populate that field again. This repo
has already paid for exactly this shape: `ufc_fmv_stale_hours` grew without bound against a closed
market, went **permanently red**, and the recorded cost was that it **trains the operator to skim
past every arm on the board**. It was re-pointed, not merely re-thresholded, to
`ufc_flow_revival_sales_30d`.

**Recommendation: re-point this arm the same way** — at the live path. Candidates: freshness of
`max(last_sale_at)`, or the share of newly-captured serials carrying a `last_sale_usd` (breach if it
falls near zero for N days, which is the question an operator actually wants answered). ⚠ Re-point
rather than retire: something should still watch Panini sale capture, and the `nftSalesData` path has
its own failure mode — it depends on the runner **clicking the sales-history tab**, so a UI change
upstream silences it.

### The threshold, derived rather than chosen

Share of newly-captured serials carrying a `last_sale_usd`, by capture day, over 30 days. **Three
clean regimes:**

| regime | days | range |
|---|---|---|
| pre-switch (`brought_at_price`, listing-gated denominator) | 07-18 → 07-26 | **40.5 – 59.5%** |
| **the outage** | 07-28 → 08-08 | **1.7 – 6.3%** |
| **post-replacement (`nftSalesData`)** | 08-09 → 08-16 | **21.1 – 38.9%** |

The outage band and the healthy band are separated by ~**4×** and do not overlap, so a gate at
**10%** fires on every one of the 12 outage days and clears every post-fix day with >2× margin.

⚠ **It needs a MINIMUM-SAMPLE FLOOR, for the reason the concierge outcome check needed one.** The
denominator swings from **280** rows (08-13, 38.9%) to **17,809** (08-16, 22.9%) — the runner walks in
bursts — so a percentage on a thin day is noise. Suggest **≥500 captured serials** for a day to count,
the same shape as that check's 5-conversation floor.

⚠ **Keep the CONSECUTIVE-DAYS form; do not gate on a single day.** 07-27 reads 21.9% — inside the
healthy band — because the switch happened mid-day, so a one-day gate would have missed the first day
of a 12-day outage. `rpc_thp_leg_panini`'s existing `runs`/`bool_or … ORDER BY capture_day DESC`
construction already computes consecutive-dry-days-from-today correctly; **re-point its INPUT and
leave that logic alone.**

### Why this is filed and not applied

Not squeamishness — three specific risks, each of which this session watched bite something:

1. It needs **two** objects changed: `rpc_thp_leg_panini` (1,622 chars, tractable) **and**
   `v_rpc_trust_health`, which must carry the new metric's `breach_at` + `catches`. ⚠ That view is
   large and `CREATE OR REPLACE VIEW` **silently strips `security_invoker`** — a footgun this repo has
   hit **four** times. It wants `ALTER VIEW` discipline plus a post-apply
   `check_public_security_invariants()`.
2. The threshold above rests on **8 post-fix days** — enough to separate the regimes, not enough to
   characterise seasonality. This arm **pages an operator**, and the repo has already paid twice for a
   cry-wolf threshold.
3. A precompute leg cannot be meaningfully validated in a rolled-back transaction against real capture
   data, so "it applies cleanly" would not be the same as "it measures the right thing."

**Everything needed to apply it is above. What is missing is a threshold review by whoever owns the
pager — which is a judgement call, not a measurement.**

## 3. What the first version got right, kept because the arm's text is still wrong

The arm's `catches` still names the leading reading as *"an `all_cards` bulk variant returning a
lighter per-serial shape"* and still says *"there is no pre-switch payload on disk to diff."*

**Both are false, and `panini_card_serials.raw` — our own stored copy — settles them:** it holds
**5,876 pre-07-27 rows** of 82,511, all with `raw`.

**a) The key set is IDENTICAL across eras**, 20% deterministic hash sample: **45 top-level keys,
every one on 100% of rows in BOTH eras** (pre 1,180/1,180 · post 14,729/14,729). A lighter variant
drops keys. The shape never changed — only a value went null. **The lighter-payload reading is
refuted.**

**b) `my_public_wallet` set ⟺ `brought_at_price` null is a perfect biconditional.** Identical
COUNTS every day through the transition, including both partial ramp days:

| day | rows | `brought_at_price` null | `my_public_wallet` SET |
|---|---|---|---|
| 07-24 | 909 | 0 | 0 |
| 07-25 | 309 | 0 | 0 |
| 07-26 | 820 | 0 | 0 |
| **07-27** | 1,199 | **708** | **708** |
| **07-28** | 2,058 | **2,026** | **2,026** |
| 07-29 | 1,936 | 1,936 | 1,936 |
| 07-30 | 2,046 | 2,046 | 2,046 |
| 07-31 | 779 | 779 | 779 |

On the two ramp days, where both states coexist on the same box in the same walk (n = 3,257):
**wallet-set-but-price-present 0 · wallet-null-but-price-null 0**, one distinct wallet,
`is_owner = true` on **0** rows.

**Mechanism: `brought_at_price` / `brought_at_time` are WALLET-SCOPED** — *"what did **you** pay"* —
correctly null for every card the runner does not own, and it owns none of the 82,511. This is
**consistent with and explanatory of** the 08-08 A/B: a fully signed front-end request is *also*
wallet-scoped, so of course it returned nulls too. The A/B varied `listType`; the live axis was
scope.

⚠ It also explains the two fields the arm correctly set aside: post-switch `buy_now_price` null is
76% and `best_offer` 16%, which is the documented DOM-harvest coverage fix ending listing-gating —
unlisted cards have no buy-now price. **Not part of this defect.**

## 4. Suggested actions (none taken)

1. **Re-point the arm** (small migration, batch it) at the live `nftSalesData` path, per §2.
2. **Correct the arm's `catches` text** in the same migration: drop the refuted lighter-payload
   reading and the false "no pre-switch payload on disk" claim; record the biconditional and that
   the field is dead-and-replaced.
3. **Do NOT re-run the `listType` A/B** — done 2026-08-08, settled, `listType` inert.
4. **Do NOT re-derive** the three branches the arm already disproved.
5. *Optional, low value now:* the one untested axis is scoped-vs-**UNSCOPED** (the 08-08 A/B did not
   try it). It would confirm the mechanism, but the replacement already supplies the data, so this
   is curiosity rather than need.

## Reproduce

```sql
-- the live replacement is healthy
select captured_at::date d, count(*) captured,
       count(*) filter (where last_sale_usd is not null) with_sale_price
from panini_card_serials where captured_at > now() - interval '10 days'
group by 1 order by 1 desc;

-- the biconditional, on the two days where both states coexist
select count(*) rows,
  count(*) filter (where raw->'my_public_wallet' <> 'null'::jsonb
                     and raw->'brought_at_price' <> 'null'::jsonb) wallet_set_but_price_present,
  count(*) filter (where raw->'my_public_wallet' = 'null'::jsonb
                     and raw->'brought_at_price' = 'null'::jsonb) wallet_null_but_price_null
from panini_card_serials
where captured_at::date between date '2026-07-27' and date '2026-07-28';
```
