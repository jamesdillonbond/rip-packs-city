# Physical cards — where this stands (2026-11-23)

Start here before touching anything under `lib/physical/`, `app/api/physical/`, `components/physical/`, `scripts/physical/` or this folder. Every number below is a DATED SAMPLE; re-derive before quoting it.

## The ask, and what is decided

- **Trevor, 2026-11-21:** consider letting collectors add the paper cards they own (sports RPC already covers, plus Topps Marvel, Pokémon, Magic…), valued as a RANGE by grade or condition.
- **2026-11-22 8:07 PM PT:** "Are we able to start drawing comparisons of FMV and sale price across digital and physical Panini products?" — the answer is no, not until a licensed paper sold-price feed is in place. The matching was built so the comparison can start the day it is.
- **Standing that day:** "Don't send anything to anyone." No vendor has been contacted. Drafts sit in the Project doc `claude/physical-cards-outreach-drafts-2026-11-22.md`.

**Trevor's decisions, all still open:**
1. HobbyCardIndex (HCI) free setup month: internal testing only. Public display needs Commercial Lite, ~$99/mo.
2. eBay Partner Network application, then Buy API production access. This is a revenue decision.
3. Apply `physical-holdings-draft.sql` and `panini-physical-crosswalk-draft.sql` as migrations.
4. Where physical cards appear on the site relative to the digital portfolio.

## Everything is OFF

| Part | Off because |
|---|---|
| `app/api/physical/cert`, `app/api/physical/holdings` | 404 unless `PHYSICAL_CARDS=1` **and** `HCI_API_KEY` are set (`lib/physical/flags.ts`). Neither is set. |
| `components/physical/PaperCardListings.tsx` | No page imports it. It also needs `PHYSICAL_EBAY_LISTINGS=1` + `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET`. The mount line is in its header. |
| `physical-holdings-draft.sql`, `panini-physical-crosswalk-draft.sql` | Drafts kept out of `supabase/migrations/` on purpose, because migration-parity expects every file there to be applied. **Not applied.** |
| `scripts/physical/*` | Offline backtest runner and read-only Polygon probes. Nothing schedules them. |

## Rules the code keeps (do not loosen without a reason)

- **A paper value never enters RPC FMV.** It lives in `physical_value_cache`, credited to its source, as a range. A holding without a range is **unpriced**, never $0 (`lib/physical/portfolio.ts`).
- **Only confirmed paid sales count, at the exact grader and grade.** A Best Offer row that reports the asking price is dropped. Prices are never borrowed across grades. A STALE value is capped at the last sale (`lib/physical/valuation-range.ts`). `internalConfidence` is never rendered.
- **A paper value goes public only after it passes the walk-forward backtest:** median absolute error ≤ 20 % and ≥ 60 % of sales within ±25 % (`lib/physical/backtest.ts`, `scripts/physical/backtest-run.ts`).
- **eBay licence:**
  - listings shown are never more than 6 h old, refused at read (§8.1(c));
  - eBay content sits in its own section (§8.1(b)(2));
  - asks never suggest or model a price (§9.6).

  The cache refreshes at 5 h, and a daily cap that fails closed bounds calls (`ebay-listings-*.ts`).
- **HCI terms:** stored data must be deleted within 30 days of a plan ending; the cache table cascades for that.
- **Holdings:**
  - each user is capped at 1,000 rows, in the route and by a trigger in the draft;
  - a typed date is either stored or refused;
  - cost basis is the total paid for the row (the whole lot);
  - signed-in clients may only SELECT, and every write goes through the route.

## Digital ↔ paper matching (Panini)

`lib/physical/panini-crosswalk.ts` (matcher) + `panini-physical-crosswalk-draft.sql` (view) + `panini-hci-lookup-list.sql` (which cards to look up first).

- **The paper card is derived from the NFT:**
  - Paper product = NFT product name minus " NFT ". The 2021 "NFT NFL Prizm / Donruss Optic" lines map to "2021 Panini Prizm Football / Donruss Optic Football".
  - The BC reprint sets carry the paper year in `set_name`.
  - The paper card number is the last `_` segment of `panini_editions.external_id`. 23 of 23 checked against published paper checklists on 11-22.
- **Person:** resolved via `editions.player_id → players`, matched against the ESPN crosswalk keys with trailing dashes trimmed (the Jr./Sr. fix, migration `20261123050843`, applied). Multi-person cards are excluded; ambiguous names are never picked.
- **Coverage:** 42,311 comparable editions carry $1.37M of $1.44M of 90-day digital sales on paper-program cards.
- **Print runs usually DIFFER.**
  - 2026 Prizm World Cup matches paper only on Gold /10, Black 1/1 and Choice Nebula 1/1. Old Glory, for example, is /7 digital and /94 paper.
  - 2026 Prizm WNBA matches on Gold /10, Mojo /25, Black Gold /5, Plum Blossom /8 and Gold Vinyl 1/1.
  - Show both print runs and never call the gap a premium on the same object. The matcher flags `printRunMatch`.
- **Comparison method (recommended, Trevor's call):** realised median against realised median, same card, grade, print run and window. Digital FMV (panini-1.4.2, HIGH: 22.2 % median error, 51.6 % within ±25 %) fails the bar set for paper, so FMV is not put against FMV until both pass the same bar.
- **Lookup list for the HCI month (500 `/sales` calls):**
  - cards need 3+ digital sales in 90 days, because a median of one sale is not a comparison;
  - confirmed same-print-run pairs rank first, then the rest by dollars;
  - live on 11-23: 248 like-for-like 2026 Prizm WNBA cards, then 252 by dollars, $436,961 of digital 90-day sales;
  - the paper side needs 3+ sales too, so expect usable pairs to cluster on the stars.

## Verification on record

Read the ledger first: entries 2026-11-22 ~8:30 PM → 2026-11-23 ~10:58 AM PT.

- **Tests:** 9 `__tests__/physical-*` files, 105 tests (96 + 9 in the components config; all green 2026-11-23 ~11 AM PT).
- **Draft SQL** was applied to scratch Postgres 16 with Supabase-style default grants:
  - the signed-in role gets SELECT only, and anon gets nothing;
  - truncate is refused;
  - RLS shows a user only their own rows;
  - the 1,001st row is refused;
  - raw-with-grade, grade 11 and negative cost are refused.
- **Review:** `review-2026-11-22-prototype.md` lists the overnight findings. All are fixed: 2 and 9 overnight, the rest 2026-11-23 ~7:30 AM PT.

## Research kept for later

Project docs: `claude/handoff-2026-11-22-physical-cards-prototype.md` and `claude/handoff-2026-11-22-panini-physical-crosswalk.md`.

- **Courtyard (Polygon):** ~94 % of "trades" are Courtyard's own buyback wallet, so a peer price can only come from the ~1,350 single-token trades a day. Pack openers got back a median 0.70 per $1, dollar-weighted 0.82. Card identity needs a data partnership.
- **Gated** by the 2026-10-17 real-world-asset decision ("a future add, not right now") and by the accuracy gate. Nothing here is promoted.
