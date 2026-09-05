# The entire NFL All Day **Genesis** set has no art at its upstream — 47 of 52 images blank on its set page — and the new blank-art smoke gate is scoped past it

**Filed 2026-09-05 09:40Z (02:40 PT) · Cowork (cloud), overnight block 3 · MEASURED, NOT SHIPPED — there is nothing on our side to fix, and that is the finding**

## What

`/nfl-all-day/set/genesis` renders **47 of 52 images blank** (scrolled to force every lazy
image; `pending: 0`, so that is the settled number, not a timing artifact). Only **3 of 50**
`media.nflallday.com` images on the page load at all.

**Genesis is 352 editions, Series 1, every one `tier = ULTIMATE` and `circulation_count = 1`** —
NFL All Day's one-of-one trophy tier. 1 of the 352 is held by a wallet in
`wallet_moments_cache`; the set carries 6 sales.

## It is upstream, and that was checked rather than assumed

`editions.thumbnail_url` for Genesis points at
`https://media.nflallday.com/editions/<id>/media/image?width=512&format=webp&quality=90`.

**Sampled 15 Genesis ids: 0 of 15 return 200.** Against two control groups drawn the same way
from the same collection:

| group | population | sampled | 200 |
|---|---|---|---|
| **Genesis** | 352 | 15 | **0** |
| `%(Parallel)%` sets | 912 | 15 | 14 |
| everything else | 4,926 | 15 | **15** |

⭐ **A rate hid a class.** A blind 60-edition sample across all of All Day read **3 bad / 60 =
5.0%**, which looks like scatter and invites a shrug. It is not scatter: Genesis is 352 of 6,190
editions (5.7%) and it is **entirely dark**, while the rest of the collection is essentially
clean. The rate and the class point at completely different actions.

**No alternate source serves them.** For three failing ids, four URL shapes were tried and all
four 404: the stored `?width=…&format=webp` form, the bare `/media/image` form, `/media/video`,
and the same path on `assets.nflallday.com`. **The video is gone too, not just the still.** So
this is Dapper having removed (or never published) the media for that set, and there is no
fallback for us to reach for — unlike the UFC/IPFS case closed hours earlier, where the bytes
existed and only our gateway list was wrong. ⭐ Distinguishing "the content is gone" from "we are
asking the wrong host" is the whole decision here, and it is why nothing was shipped.

## 🚨 Why this matters to the gate that shipped tonight

The E2E smoke gained a check that **fails a page whose media-proxy art is entirely blank**
(ledger 2026-09-05, `8e220cc`). ⚠ **That check is scoped to our own media-proxy routes**, and
Genesis art is served **direct from `media.nflallday.com`**, which is a CSP-allowed CDN rather
than a proxy route. **So a page can be 90% blank and still pass both assertions** — the ratio
arm because most images are not same-origin, and the proxy arm because none of the blank ones
are proxy URLs.

This is not an argument to widen the gate reflexively — the ledger entry for it already explains
why the ratio arm has a floor and why the proxy arm must not become a flat ban. It is the
missing third case, recorded so whoever revisits that gate knows the shape it does not cover.

## What I did NOT do, and why

⛔ **No code change.** There is no source to fall back to, so a fallback would be a placeholder,
and choosing what a missing trophy-tier Moment should look like is a product decision.
⛔ **No data change.** The stored URL is the correct one; it is the upstream object that is
absent. NULLing 352 `thumbnail_url`s would trade a broken image for a missing one and destroy the
record of what the URL was, for no gain.

## Cheap checks for whoever picks this up

```bash
# Does the upstream still 404? (one id from each control group)
curl -s -o /dev/null -w "genesis 168 -> %{http_code}\n" \
  "https://media.nflallday.com/editions/168/media/image?width=512&format=webp&quality=90"
curl -s -o /dev/null -w "control 5329 -> %{http_code}\n" \
  "https://media.nflallday.com/editions/5329/media/image?width=512&format=webp&quality=90"
```

If Genesis starts answering 200 again, this filing is closed by the upstream and needs no action
at all. ⚠ **Re-measure with a SAMPLE, not one id** — a single 200 proves nothing about 352 rows,
which is the mistake the 5% reading above would have led to in the other direction.

---

## OUTCOME, same night — the gate gained a third arm, and it still does NOT cover Genesis

*Appended by Claude Code (Trevor's box) 2026-09-05 ~03:30 PT, ledger entry the same date.*

The §"Why this matters to the gate" section above was acted on. `assertHealthyPage` now carries a **third arm**: for each third-party host with ≥4 decided images on a page, more than 50% blank fails.

⭐ **What made it non-reflexive was the measurement this filing asked for.** Across 13 pages and ~400 third-party images grouped **by host**: `assets.nbatopshot.com` 0/114 and 0/44, `media.nflallday.com` 0/31, 0/29 and 0/105, `assets.laligagolazos.com` 0/31, `arweave.net` 0/3 — **every healthy host at 0% blank**, against this filing's Genesis page at **15/19 = 79%**. Healthy and broken are separated by the whole range.

⛔ **BUT IT DOES NOT CATCH GENESIS, AND THAT IS NOT AN OVERSIGHT.** `entity-smoke` picks its `set` page with `.find()` — the FIRST `/set/` URL in sitemap 3, deterministically **`/nba-top-shot/set/clamps`**. Genesis appears in that sitemap exactly once and is never selected, so no covered page renders its art.

⭐ **The same fact is why the arm was safe to ship.** Had the smoke reached Genesis, this arm would have pinned the badge red on an upstream nobody can fix — the "alarm whose clearing condition is outside the estate stays red forever" trap, which is precisely the argument for the `edge-fn-drift` acknowledgement. **This filing's own conclusion — that there is nothing on our side to fix — still stands, and the gate does not now contradict it.**

What the arm DOES cover is the same failure on pages the smoke actually visits: `/insights/top-sales` carries **114** Top Shot CDN images and `/nfl-all-day/market` **31**. Those hosts going dark was invisible to every instrument we had, and is not any more.

⚠ **So this filing stays OPEN as a product/upstream question** (352 ULTIMATE 1/1 editions with no art, no fallback source, and NULLing the URLs would destroy the record). Only its gate-shaped half is discharged.
