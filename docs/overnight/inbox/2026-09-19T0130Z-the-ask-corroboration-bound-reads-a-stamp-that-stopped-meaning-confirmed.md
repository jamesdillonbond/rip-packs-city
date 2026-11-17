# R103 re-derived — the ask-corroboration bound is applied to a column whose contract changed under it

*Cowork cloud, filed 2026-09-18 ~6:35 PM PT (09-19 01:30Z). **READ-ONLY — nothing shipped in the pricing path.** One zero-risk DB comment shipped alongside; see the ledger entry of the same date.*

## The filing being re-derived

R103 (ledger 2026-09-18): *"34.4% of TS asks are past their own corroboration bound (26× the 1.3% measured when it was set)."*

## ✅ The number is confirmed and current

`edition_offers`, Top Shot (`95f28a17-…`), measured 2026-09-19 01:22Z:

| | |
|---|---:|
| rows | 13,312 |
| with a `low_ask` | 13,102 |
| **past the 7-day bound** | **4,576 (34.9%)** |
| older than 30 days | 1 |
| touched in the last 12 h | 1,276 |

Against the **155 of 12,259 (1.3%)** recorded in `lib/fmv-confidence.ts` when `MAX_ASK_AGE_HOURS_CORROBORATION` was set on 2026-08-29. So ~27×, and R103's figure stands.

## ⛔ But the conclusion the number invites is wrong, and this is the finding

**Those asks are not stale. The stamp the bound reads stopped meaning "confirmed" one day before the bound was set.**

`col_description('public.edition_offers','updated_at')` says it in as many words:

> *"LAST CHANGED, NOT LAST CONFIRMED — and not necessarily about the ASK. Bumped by `sync_edition_offers_from_atlas()` only when `low_ask`/`low_ask_nft_id` actually change (its ON CONFLICT carries an IS DISTINCT FROM guard) … It was a true confirmation stamp until 2026-08-28, when offers-sweep (which stamped every row it wrapped, 8–18×/day) died and the Atlas writer replaced it (#81) — the meaning changed, the name did not."*

`app/api/fmv-recalc/route.ts` builds `editionAskAgeHoursById` from `edition_offers.updated_at` and feeds it to `liveAskAgeHours`, which `lib/fmv-confidence.ts:226` compares against the 7-day bound. **So an ask whose price has simply been STABLE for eight days is being treated as "no longer evidence about the price"** — and, in the other direction, a row can read *fresh* because `highest_offer` moved on an ask nobody looked at.

⭐ This is a **fourth surface** on the exact trap CLAUDE.md already records for this column (*"a `*_at` name is not its contract — and the contract is its WRITER's"*). The 2026-09-13 audit fixed the **display** side (`lib/market/ask-freshness.ts askStampKind()`); the **pricing** side was left reading the old meaning, and the column comment names only the display consumer.

## 📏 The decisive measurement — an independent stamp that does mean "confirmed"

`topshot_atlas_market_events.last_seen_at` is written every time the Atlas mirror sees a listing, whether or not the price moved. Joining the past-bound rows to it through `low_ask_nft_id` (open, not-completed listings only):

| | |
|---|---:|
| past-bound rows carrying an `nft_id` | 4,561 |
| **resolvable in the Atlas mirror** | **4,561 (100%)** |
| **stale by the Atlas stamp at the same 7-day bound** | **0** |
| seen within 24 h | 230 |
| mean `updated_at` age (what the bound reads) | **9.4 days** |
| mean Atlas `last_seen_at` age (what confirmed means) | **71.8 h (3.0 days)** |

**Not one of the 4,561 is actually past the bound.** Every one is an open listing the mirror has confirmed inside the window. The bound is measuring price stability and calling it staleness.

⚠ **One honest qualification on the Atlas stamp:** its own mean is 3.0 days, not hours — only 66 rows were seen within 12 h. The mirror is not refreshing these constantly, which is consistent with `ts-listings-atlas-sync` having been failing ~29% of its ticks (see the same day's autovacuum fix). The Atlas stamp is *correct in kind* and *comfortably inside the bound*; it is not evidence that the ask book is minute-fresh.

## 📐 The size of the prize — a CEILING, deliberately not a gain

Of the 4,561, by current `edition_fmv_current.confidence`:

| confidence | editions |
|---|---:|
| **LOW** | **1,633** |
| MEDIUM | 1,442 |
| ASK_ONLY | 1,360 |
| HIGH | 107 |
| STALE / NO_DATA / SALES_ONLY | 20 |

Corroboration lifts **LOW → MEDIUM only**, so **1,633 is the ceiling.**

⛔ **THE GAIN IS NOT MEASURED AND MUST NOT BE QUOTED AS 1,633.** A lift also needs `MIN_SALES_ASK_CORROBORATION` (≥3 sales) **and** a sales median inside `ASK_CORROBORATION_BAND` (±25%). *An eligibility count is not a gain count* — the last time this estate sized a lever at 173 rows it moved 54, because 119 were already in the target state. The A2 modelling in `lib/fmv-confidence.ts` put roughly 1,291 of ~2,206 eligible TS LOW editions through the band (~58%), but that is a different population on a different date and is **not** a projection for this one. Computing the real number means reproducing fmv-recalc's own sales window — including the 90-day re-fetch for thin editions — not a 30-day approximation.

## 👉 What to do, and what NOT to do

1. **The fix is to source the ask AGE from a confirmation stamp, not a change stamp** — `topshot_atlas_market_events.last_seen_at` for the row backing `low_ask_nft_id`, with `edition_offers.updated_at` kept only for "has the price moved". The join is proven above at 100% resolution over 4,561 rows.
2. ⛔ **Do NOT widen `MAX_ASK_AGE_HOURS_CORROBORATION`.** The bound is not wrong; its INPUT is. Widening it would re-admit the genuinely dead asks the 2026-08-29 measurement was taken to exclude, and would do so silently.
3. ⛔ **Not shipped here, and the reason is stated rather than implied:** this moves the confidence tier of up to 1,633 Top Shot editions, and MEDIUM is what gates the public Below-FMV board. That is a change to what RPC tells users a moment is worth. It needs the gain measured first and a human on it — it is not an unsupervised change.
4. ⚠ **Re-measure before acting.** This filing is itself a hypothesis the moment it is written. The 34.9% moves with the Atlas lane's health, and that lane's cost profile changed the same evening.

## Adjacent, not chased

`fmv_clamp_disconnected_ask_topshot` hardcodes the Top Shot UUID in both CTEs (CLAUDE.md), so All Day publishes troll asks unclamped. Different defect, same subsystem — not touched here, and not re-derived here either.
