# ⛔ Four surfaces still publish a 30h-old ask as current — and each needs a PAYLOAD change, not a rendering one

**Filed 2026-08-29 ~22:30Z (15:30 PT). Status: MEASURED AND RANKED, NOT SHIPPED.
The rendering half shipped in the same session (`212f974ac`); this is the remainder,
recorded rather than quietly dropped.**

---

## ✅ UPDATE ~00:45Z — THREE OF THE FOUR ARE SHIPPED, and one of my own claims here was WRONG

- **(1) `lib/fmv-confidence.ts` — SHIPPED** (`c537b390d`). ⚠ **The threshold is 7 days, NOT the 12 h this filing implied by pointing at the display marker.** Measured first: **12,121 of 12,259 Top Shot asks (98.9%) were older than 12 h**, against 155 (1.3%) older than 7 days. A 12 h gate would have demoted the catalogue out of MEDIUM and emptied the deals board over a transient outage — **the "honesty fix" would have been the bigger regression.** The two constants answer different questions and a test now keeps them apart.
- **(2) `lib/seo.ts` — SHIPPED** (`323ee41eb`), and **not the way this filing proposed.** Dropping the `Offer` deletes the Product rich-result from thousands of NO_DATA pages during any outage, with no honesty gain. It now emits `priceValidUntil` measured from when the ask was **confirmed** — in the future when fresh, already elapsed when stale — and withholds the Offer only past the 7-day bound. The FMV branch is deliberately ungated.
- **(3) the "% below FMV" chip — SHIPPED** (`1740a39ec`). 🚨 **"Structurally unqualifiable" was WRONG, and it was my own claim.** `get_edition_insight_links` returns no timestamp, which reads that way — but `topshot_deals_vs_fmv.discount_pct` is computed from `edition_offers.low_ask` joined on the same `(external_id, collection_id)`, i.e. **the row the page already holds**. One query on the view definition refuted it; no RPC change, no migration, two lines. ⭐ *A filed finding is a hypothesis even when it is your own and six hours old.*
- **(4) `/api/best-offers` — STILL OPEN, and MORE serious than ranked below.** This filing guessed the bid side was "probably fresher" via three other indexers. ⛔ **Refuted:** `topshot-offers-indexer` writes `public.offers`, **not** `edition_offers` — so `edition_offers.highest_offer` has the same single writer as the ask and is equally 30 h stale. ⚠ The route returns a `bestOfferSource` discriminator over **four** legs (Top Shot Edition / Top Shot Serial / Flowty Serial / Dapper Offer) with different writers, so one `updated_at` column is the wrong shape — **it needs a per-leg age**, which is why it was not folded into this pass.

**Still open: item 4 and the methodology prose. Everything else here is done.**

## The condition

`edition_offers` has ONE writer for the ask side — `offers-sweep` — and it has been
failing against the dead `public-api.nbatopshot.com` for over 30 h. Live:
**12,259 Top Shot asks, MEDIAN age 30.0 h, p90 30.3 h, 150 of 12,259 refreshed in
twelve hours.** A fan-out audit of every `edition_offers` reader found seven consumer
surfaces. Three are now honest (deals board, edition-page floor ask, bid-vs-floor).
Two were already honest and should be left alone. **Four are not, and none of them can
be fixed where they render** — the timestamp does not reach them.

## The four, in the order they are worth doing

### 1. `lib/fmv-confidence.ts` — widest blast radius, renders nothing itself

Lines 44-53 / 185-203 promote an edition **LOW → MEDIUM** on "an independent **live**
ask" that agrees with the sales median. Its only caller, `app/api/fmv-recalc/route.ts:643`,
selects `external_id, low_ask` — **no `updated_at`, no age gate.** So a 30 h ask can:

- promote confidence (the file's own comment models **~1,291** such promotions),
- seed `editionCeilingAskById` (`route.ts:678`), the ceiling that *lowers* FMV,
- price zero-sales editions outright via the `ASK_ONLY` fallback (`route.ts:1338-1439`).

⚠ **And `confidence` gates the deals board to `HIGH|MEDIUM`** — so a stale-ask promotion
can INJECT a row onto a board whose per-row caveats only exist downstream of it. Fix is
one column in the select plus a max-age on the corroboration branch.

### 2. `lib/seo.ts` — a stale ask published to Google as `availability: InStock`

`editionJsonLd` (lines 787, 834-851) emits a schema.org `Offer` from `lowAsk` with
`availability: "https://schema.org/InStock"` and no `priceValidUntil`. **The signature
has no timestamp parameter at all**, so it is structurally unqualifiable. ⭐ The function
is already sophisticated about OTHER staleness — it excludes STALE-confidence FMV
(line 835) and emits no Offer for closed markets (826-834) — and line 825 states the
premise outright: *"a live low ask is still a real, reliable price even on STALE."*
**That is the sentence that broke.** Add an optional `lowAskUpdatedAt`; past the
threshold either drop `offers` or emit a `priceValidUntil` in the past.

### 3. The edition page's "% below FMV" chip — structurally unqualifiable

`page.tsx:936-940` renders a flat `{deal_pct}% below FMV →`, derived from
`topshot_deals_vs_fmv`, i.e. from the same `edition_offers.low_ask`.
`fetchInsightLinks` (`lib/entity/edition-market-fetchers.ts:169-199`) selects only
`squeeze_pct, deal_pct, first_mint_x`. 🚨 **So the edition page asserts a bare "18%
below FMV" while the deals board it LINKS TO now marks that same row
`⚠ ask unconfirmed 30h`** — one product contradicting itself across a hyperlink, which
is the sharpest single artifact of this outage. Needs `updated_at` on the RPC payload.

### 4. `/api/best-offers` → the collection grid

`route.ts:96` selects `external_id, highest_offer` — **no `updated_at`.** Rendered bare
at `CollectionTabClient.tsx:1183` on every collection grid row and in the moment drawer.
⚠ **Lower priority for a real reason:** this is the BID side, also written by
`topshot-offers-indexer` / `allday-offers-indexer` / `golazos-offers-indexer`, so it is
probably far fresher than the ask column. **But the route cannot prove that either way,
because it never fetches the timestamp** — "probably fresh" is a story, not a
measurement, and that is exactly the gap. One column in the select plus a field on
`BestOfferResult`.

## Also worth a line: `lib/analytics/methodology.ts`

Public prose. Line 128 says Top Shot ask data comes from `edition_offers` and pairs it
with `refresh: "Every 5 minutes (page revalidate)"` — which is the PAGE's revalidate,
not the feed's cadence, and reads as if the asks are five minutes old. Line 59 calls the
`ASK_ONLY` input a "**live** ask". No number is rendered, so this is documentation
honesty rather than a live falsehood — lowest priority, but the word "live" appears
three times against a feed that has been dead for a day and a quarter.

## ✅ Leave alone — measured honest, both directions recorded

- **`components/entity/EditionActivity.tsx`** — a FALSE POSITIVE in the file list. It
  reads `public.offers`, not `edition_offers` (the only mention is a comment), and it is
  the best-behaved surface in the set: every row carries `<RelTime iso={o.made_at} />`
  under a `When` header.
- **`lib/entity/section-empty-copy.ts`** — no timestamp, and none needed. It is the
  failed-vs-empty helper and already prevents the adjacent defect. ⭐ Worth naming as
  precedent: it distinguishes *couldn't look* from *looked and found none*. Ask staleness
  is the **third** state — *looked, but 30 hours ago* — and nothing generalises it
  outside `lib/market/ask-freshness.ts`, which this session created for exactly that.
- **The edition page's best-offer cell and `% Listed`** — already stamped / already
  em-dashed rather than faked.

## ⚠ One methodological note worth keeping

The rendering fixes were verified by a test asserting the **ABSENCE of the false claim**,
not the presence of the ⚠ marker — and that is what caught a **third** copy of
"refreshes continuously" in the bid-vs-floor methodology footer, plus two more in code
comments. A test checking only for the warning would have passed on a page that
contradicted itself in the same viewport. **When retiring a claim, grep the claim.**
