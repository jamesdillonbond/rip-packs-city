# `/insights/deals` says "Updated 9 minutes ago" over Top Shot asks last verified **23 hours** ago — the MV-freshness fix stopped one layer short

**Filed 2026-08-29 ~16:05Z (09:05 PT). Status: MEASURED, NOT SHIPPED — the fix needs a product decision and a hasty one would state a NEW falsehood.**

This answers the question `2026-08-28T2320Z-topshot-upstream-5xx-outage…` left open:
*"whether any user-facing surface currently labels Top Shot marketplace data with its
age."* It does — and the label reads the wrong clock.

## The chain, each link measured

1. `offers-sweep` is the ONLY writer of `edition_offers.updated_at`, which is a
   **verification** stamp: it walks Top Shot GraphQL 40 pages a tick and upserts
   `low_ask` + `highest_offer` per edition. `edition_current_ask` is a VIEW over it.
2. **Normal cadence, from `pipeline_runs.extra->>'wrapped'`:** 08-26 → **8 full wraps**,
   08-27 → **18**, 08-28 → **12**. At 18 wraps/day every Top Shot edition is
   re-verified about every **80 minutes**. 209,808 rows written on 08-27 alone.
3. **Since the outage: 47 runs, 0 ok, 0 wraps, 0 pages, 0 rows written.** Last success
   18:00Z on 08-28. Every failure is `Top Shot GraphQL failed with 530` / `503`.
4. **Result now:** of 12,539 Top Shot editions in `edition_offers`, **139 (1.1%)** were
   verified in the last 12 h; 4,231 are older than 24 h. Median age **23.8 h** — roughly
   **18× the normal interval.**
5. `cross-collection-deals-mv` is **healthy — 47/47 ok in 24 h**, refreshing every 30
   min over those stale inputs. On the live board right now: **9 of the 10 Top Shot rows
   have not been verified in over 12 h** (median 23.1 h).
6. The page renders `Updated <FreshnessStamp iso={data_as_of}/>`, and `data_as_of` is
   `readMvAsOf("deals")` = **when the MV last refreshed**. So it currently reads
   **"Updated ~9 minutes ago."** Beside it sits fixed copy: **"Asks refresh continuously."**

⭐ **`lib/insights/mv-freshness.ts` exists to prevent this exact sentence and stops one
layer too high.** Its own docstring: *"`fetched_at` is the house convention … Behind an MV
that is no longer true. The fetch happens now; the rows may be up to a full refresh
interval old … the page was telling a collector the board was current when it could be
half an hour behind — on a board whose entire purpose is listings that disappear."*
It replaced *fetch time* with *MV refresh time* and that is still not *data time*. **A
successful MV refresh over a dead input feed is the same lie in a new place** — and it is
worse than the one that was fixed, because a broken upstream makes the MV stamp look
BEST exactly when the data is worst.

## ⚠ THE TRAP — I got this wrong first, and the wrong version is the plausible one

`mv_cross_collection_deals` UNIONs three branches into one `ask_updated_at` column, and
**the column does not mean the same thing in all three:**

| branch | source column | what it actually means |
|---|---|---|
| Top Shot | `edition_offers.updated_at` | **last VERIFIED** by `offers-sweep` |
| Pinnacle | `pinnacle_catalog.floor_ask_updated_at` | **last VERIFIED** |
| All Day | `allday_edition_floor_ask.floor_ask_listed_at` | **when the listing was CREATED** |

My first reading was *"All Day is worse — median 210 h, oldest 2,296 h (95.7 days)."*
**That is wrong and it is not a small error.** A 95-day-old All Day row means *this
listing has been up for 95 days*, which is ordinary and possibly interesting; it does
**not** mean we have not checked. ⛔ **And it cannot be fixed by picking a better column:
`allday_edition_floor_ask` has only five columns and NONE of them is a verification
timestamp.** The All Day branch has no way to express the thing the other two express.

⛔ **So any fix that blends the three into one "asks last checked N ago" stamp publishes a
new falsehood for a third of the board.** That is why this is filed rather than shipped.

⭐ **Third asymmetry, and it is the one with a precedent to copy:** only the Pinnacle
branch carries a staleness gate — `AND pc.floor_ask_updated_at > now() - '3 days'`. Top
Shot and All Day have none. Whoever wrote the Pinnacle branch already decided this
question once, for one collection, and nothing carried it across.

## What is NOT true, stated so it is not escalated wrongly

- ⛔ **"Top Shot data is a day old" is FALSE.** Sales and FMV are current — the newest
  `fmv_snapshots` row is **5.1 minutes** old, because pricing reads indexed on-chain
  `sales`, not GraphQL. **Asks and offers** are what is frozen.
- ⛔ **This is not purely an outage artifact.** The outage made the Top Shot half acute,
  but the missing staleness gate and the wrong-clock stamp are pre-existing and will
  survive recovery. **Do not close this when Top Shot comes back.**
- ⚠ **"Asks refresh continuously" is TRUE in steady state** (every ~80 min) and false
  today. Deleting it would remove accurate information; it needs a condition, not a
  deletion — which routes back to the same product decision.

## Proposal (needs Trevor, not code)

The board is public, no-signup, and its lede already warns a gap "can be a real steal —
or a low-serial / **stale listing**." It then stamps the whole thing 9 minutes old.

1. **Cheapest honest change:** carry `ask_updated_at` into the stamp **per collection**,
   never blended, and label the All Day one as *listed*, not *checked*.
2. **Copy the decision that already exists:** extend Pinnacle's `> now() - 3 days` gate to
   the Top Shot branch. ⚠ Size it first — it would drop **9 of the 10** Top Shot rows
   showing today, so it converts a wrong board into a nearly-empty one, and an empty
   board needs the honest-empty treatment (`boardEmptyCopy`), not a silent shrink.
3. **The condition for the fixed copy:** it can only be stated when the feed is live, so
   it needs the same per-collection age the stamp needs. One computation serves both.

## The alert path: checked this pass, and the answer is worse in shape but not in reach

⛔ **There is NO freshness gate anywhere in the deal-alert chain.** Checked directly rather
than assumed — `ask_updated_at` is SELECTed and carried the whole way and never used as a
predicate or shown:

| object | carries `ask_updated_at` | gates on it |
|---|---|---|
| `topshot_deals_vs_fmv` (view) | yes | **no** |
| `cross_collection_deals_board` (view) | yes | **no** |
| `build_deal_alerts_for_subscription` | yes | **no** |
| `dispatch_due_deal_alerts` | yes | **no** |
| `lib/alerts.ts` payload type (`ask_updated_at?: string \| null`) | yes | **never read** |
| `lib/alerts/format.ts` (renderer) | — | **never renders it** |

⭐ **This is the canon's worst sub-class by SHAPE** — an alert's output is silence, so a
wrong one is unfalsifiable, and "this edition is 30% below FMV, go buy it" computed from a
23-hour-old ask sends a collector after a listing that is very likely gone.

⚠ **But state the reach honestly: it is currently LATENT, not live.** There are **2 active
`alert_subscriptions`** and **0 rows in `alert_deliveries` in the last 24 h** — so nobody
was emailed a stale deal during this outage. (The 9 rows in `alert_notifications_sent` in
that window are OPS pipeline alerts — different table, different system, not deal alerts.
Reading them as user deliveries would overstate this by 9.)

**So the alert gap is a design gap to close before the alert product has users, not an
incident.** It is the same missing predicate as the board, in a path where the consequence
is worse — which argues for fixing it in the shared view (`cross_collection_deals_board`),
where one gate would serve both, rather than at either surface.

⛔ **NOT established:** whether the 0 deliveries are a cooldown/dedup effect or the two
subscriptions' own filters — not chased, because it does not change the finding either way.
Also unchecked: every other reader of `edition_current_ask` (`/api/market`,
`app/api/support-chat`, the scanners' price-only path) for an undated render.

---
## ✅ THE ALERT PATH now SAYS the ask's age (2026-09-04 02:4xZ, Claude Code on Trevor's box) — the board half stays Trevor's

The table above was right: `ask_updated_at` reached `lib/alerts/format.ts` and was never rendered. All three channel renderers (Telegram, Discord field, email line) now carry **"ask seen Nm/Nh/Nd ago"**, with **"— may be gone"** from 24 h; an unknown stamp renders nothing (not fresh, not invented). Wording is "seen" on purpose — the stamp means *verified* on the Top Shot/Pinnacle branches and *listed* on All Day, and "seen" is true of all three (the trap this filing recorded). **Not done, deliberately:** dropping stale asks from the chain (a threshold = product call, and with 2 subscriptions / 0 deliveries the reach is latent) and the board's per-collection stamp (§Proposal, Trevor). Tests pin all three channels with a fixed clock, both directions.
