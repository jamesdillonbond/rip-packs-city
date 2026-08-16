# `panini_sale_price_capture_dry_days`: the mechanism is WALLET SCOPING, and the leading hypothesis is refuted

**Filed 2026-08-16 16:55 PDT / 23:55Z (Claude Code, read-only investigation). Nothing shipped.**

The arm has read "MECHANISM NOT YET ESTABLISHED" since 2026-08-04 and is at **19 dry days**. Its
own text names the leading reading as *"an `all_cards` bulk variant returning a lighter per-serial
shape"*, and says settling it "needs a live A/B across `listType` values on the residential runner
box — interactive work, not a code read."

**Two of those premises are wrong, and the mechanism is now established from data we already hold.**

---

## 1. "There is no pre-switch payload on disk to diff" — there is, in our own DB

That statement is true of the **runner box's** ops captures. It is not true of
`panini_card_serials.raw`, which is our own stored copy of the per-serial payload:

| | rows |
|---|---|
| total, all with `raw` | **82,511** |
| captured **before** 2026-07-27 | **5,876** |
| captured **on/after** 2026-07-29 | **73,378** |

So a pre/post payload diff was available the whole time.

## 2. The "lighter payload" hypothesis is REFUTED — the key set is identical

20% deterministic hash sample, `jsonb_object_keys` over both eras:

- **45 distinct top-level keys, and every one appears on 100% of rows in BOTH eras**
  (pre 1,180/1,180 · post 14,729/14,729). Not one key is missing post-switch.

A lighter variant would drop keys. **The response shape did not change at all.** `brought_at_price`
is present as a key in both eras, exactly as the arm records — what changed is only its VALUE.

## 3. What DID change: `my_public_wallet` inverted, and it is a perfect biconditional

| field | pre (1,180) | post (14,729) |
|---|---|---|
| `brought_at_price` null | **0%** | **100%** |
| `brought_at_time` null | **0%** | **100%** |
| `my_public_wallet` null | **100%** | **0%** |
| `owner` null | 0% | 0% |
| `is_owner = true` | **0** | **0** |

Day by day across the transition — **identical COUNTS, not merely identical percentages**, including
both partial ramp days:

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

And the strongest available test — the two ramp days, where BOTH states coexist on the same box in
the same walk (n = 3,257):

- rows with wallet SET but price PRESENT: **0**
- rows with wallet NULL but price NULL: **0**
- `distinct my_public_wallet`: **1**   ·   `is_owner = true`: **0**

**Zero exceptions in either direction.** `my_public_wallet` set ⟺ `brought_at_price` null.

## 4. The mechanism

`brought_at_price` / `brought_at_time` are **WALLET-SCOPED**: with a wallet-scoped session the API
answers *"what did **you** pay for this"*, which is correctly null for every card the runner does not
own — and `is_owner` is true on **zero** of 82,511 rows. Unscoped, the same field carries the public
last-sale price.

**The capture is not broken and upstream did not stop sending. On 2026-07-27 the runner began
sending a wallet-scoped session, and the field silently changed meaning.**

This fits every observation the arm already records: key present with null value (same shape,
different semantics); every parallel family collapsing ~30× uniformly (it is global, not
compositional); `getCardMarketStats` firing 2,412 times at HTTP 200 (the request succeeds — it is
answering a different question); and the 07-27 → 07-29 ramp (session rollout across pages).

⚠ It also explains the two fields the arm correctly set aside: `buy_now_price` null rose to 76% and
`best_offer` to 16% post-switch, which is the documented DOM-harvest coverage fix ending
listing-gating — unlisted cards have no buy-now price. Those are **not** part of this defect.

## 5. What is proven vs. what still needs the A/B

- **PROVEN:** identical key set (refutes "lighter shape"); the biconditional above, 10,056 rows
  across the transition, zero exceptions.
- **STRONGLY IMPLIED:** the field is wallet-scoped, so the lever is the session, not the parser.
- **STILL NEEDS ONE TEST:** that sending the sale-price request **unscoped** makes the price return.
  The A/B the arm asks for is still the right test — but it now has a specific, cheap prediction to
  falsify, rather than a search across `listType` values.

## 6. Suggested next actions (none taken)

1. **Runner (operator, Trevor's box):** capture `getCardMarketStats` once with the wallet-scoped
   session and once without, on the same psku. Prediction: unscoped returns a non-null
   `brought_at_price`; scoped returns null.
2. **Arm text (small migration, batch it):** the `catches` text still names the refuted
   lighter-payload reading as leading. It should record the biconditional instead. ⚠ Its own
   standing instruction — *do not install a mechanism without the A/B* — is why this is **filed and
   not applied**: what is offered here is a refutation plus a measured association, and the causal
   claim still wants the one confirmatory test.
3. **Do not** re-derive the ruled-out branches (a) upstream outage, (b) walk abandoning detail
   pages, (c) `price_usd`/`best_offer_usd` loss — the arm disproved all three and this filing does
   not disturb them.

## Reproduce

```sql
-- the biconditional, on the two days where both states coexist
select count(*) rows,
  count(*) filter (where raw->'my_public_wallet' <> 'null'::jsonb
                     and raw->'brought_at_price' <> 'null'::jsonb) wallet_set_but_price_present,
  count(*) filter (where raw->'my_public_wallet' = 'null'::jsonb
                     and raw->'brought_at_price' = 'null'::jsonb) wallet_null_but_price_null
from panini_card_serials
where captured_at::date between date '2026-07-27' and date '2026-07-28';
```
