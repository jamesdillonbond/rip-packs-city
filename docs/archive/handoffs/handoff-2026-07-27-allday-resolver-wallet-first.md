# Addendum 2026-07-27 — I was wrong about the yield, and `sold_at ASC` is the wrong fix

Supersedes the ordering-flip recommendation in `docs/handoff-2026-07-27-alert-triage-addendum.md`.
**You were right to decline that flip.** This replaces it with a different change, and lowers my
recovery estimate by ~5×.

---

## 1. Retraction: my estimate fell every time the sampling design improved

| estimate | basis |
|---|---|
| ~13,000 | one n=25 row sample (48%) |
| ~9,500 | stratified rows, February 36/115 (31%) |
| ~7,400 | population-weighted by buyer-usability |
| **~2,100** | **wallet-level sampling, row-weighted (13.2%)** |

**A number that falls monotonically as the design tightens is a design artifact, not a signal.** That
is the honest summary of my own contribution here, and it is the same failure I flagged in the ledger
this morning — arriving at a confident figure from a sample whose structure I hadn't examined.

### The specific error

Rows are **not** independent draws. February's has-usable-buyer backlog is **15,828 rows across just
683 wallets** — mean 23 rows/wallet, max **2,492**, and **99.9% of rows sit in wallets holding ≥10
rows.** My "n=50" was really n≈30 wallets; my CIs were computed on a sample size I did not have.

Your 0/80 fits this perfectly: probe 80 rows and you may be probing 6 wallets. When I re-probed the 17
February rows the live pipeline had just called nil, **12 of the 17 shared one wallet**, and I got
0/17 — agreeing with the pipeline for the third time. All six of those wallets *do* publish a
borrowable `/public/AllDayNFTCollection`; they simply no longer hold the moments.

## 2. The correctly-designed measurement

One row per **distinct** February buyer, n=40 wallets, 0 transport errors:

```
WALLET-LEVEL : 20/40 wallets still hold the probed moment   (50%)
ROW-WEIGHTED : 140/1057 backlog rows sit in those wallets   (13.2%)
```

The gap between 50% and 13.2% is the whole story: **the wallets that still hold are small
(1–15 rows); the wallets that own most of the backlog are dealers who moved everything.**
Row-weighted 13.2% carries wide uncertainty — a handful of large wallets dominate it.

## 3. Resolvability is a WALLET property — verified

Follow-up probes on three wallets from that sample:

| wallet | backlog rows | follow-up | reading |
|---|---|---|---|
| `0xe4f713a8e34949f8` | 430 | **0/6 held** | one probe would have written off 429 |
| `0x0443bb06b96ba03f` | 251 | **0/6 held** | one probe would have written off 250 |
| `0x19c4d1ed5cffac6c` | 71 | **4/6 held** | worth walking in full |

## 4. The change: probe wallet-first, not date-first

Replace date ordering with a wallet classification pass:

1. Select **one** unprobed row per distinct `buyer_address`.
2. Borrow it. On a **hit**, queue that wallet's remaining rows normally. On a **miss**, stamp the whole
   wallet as cold (a `last_wallet_probe_at` on a small `allday_resolver_wallet_state` table, or just
   stamp every row of that wallet) and revisit on the existing 14-day `REATTEMPT_AFTER_DAYS` cadence —
   a wallet can re-acquire.
3. Keep `sold_at DESC` as the tie-break inside a wallet.

**Why it matters more than the recovery.** At `ON_CHAIN_MAX = 60` and ~3 ticks/hour:

| | probes to classify all of February |
|---|---|
| today (row-at-a-time) | 15,828 → **~264 ticks ≈ 3.7 days** |
| wallet-first | 683 → **~12 ticks ≈ 4 hours** |

The two mega-wallets alone currently burn ~11 ticks of Flow REST budget to establish what **2 probes**
establish. Given that DB/Flow time is the binding constraint here and WAU is 0, **the efficiency
argument is the real one — the ~2,100 recovered rows are a secondary benefit.**

⚠ It is a heuristic, not a proof: 4/6 on the hit wallet means a wallet is not all-or-nothing. Probe
2–3 per wallet before marking it cold if you want margin, at 2–3× the classification cost (still ~30×
cheaper than today).

## 5. Also fine to do nothing

`still_unresolved` has been flat at 50,520 for hours and nothing user-facing depends on it. If ~2,100
rows over a wide interval isn't worth a code change, **the honest call is to leave the rotation as it
is** — it is already bounded, honest, and cheap. It will grind March/late-Feb (0% strata) into
February over roughly the next 3 hours from 21:00Z, and the resolve rate will start to move then. If it
does not move at all once several hundred February rows are probed, even my 13.2% is too high and the
on-chain leg should be retired rather than reordered.

## Verification

```sql
SELECT count(DISTINCT buyer_address) FILTER (WHERE last_onchain_attempt_at IS NOT NULL) AS wallets_probed,
       count(*) FILTER (WHERE last_onchain_attempt_at IS NOT NULL) AS rows_probed
FROM unmapped_sales
WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND price_usd>0 AND sold_at<'2026-03-01';
```
Today `rows_probed` climbs while `wallets_probed` crawls. After the change they should climb together,
`wallets_probed` leading.

## Revert

Ordering/selection change only. Revert = restore the current
`last_onchain_attempt_at ASC NULLS FIRST, sold_at DESC`. No schema change unless you add the
wallet-state table, in which case drop it.

**Claude Code's direct file inspection wins over this doc on any disagreement.**
